import { z } from "zod";
import { renderKnowledgeContext } from "@/lib/knowledge/retrieval";
import { ProvenanceError } from "@/lib/knowledge/service";
import { createPost } from "@/lib/repo/posts";
import { EVIDENCE_STRENGTHS, EVIDENCE_TYPES, type EvidenceType, type Post, type Source } from "@/lib/types";
import { numberedSources, postWriterSystemPrompt, researchSystemPrompt } from "./prompts";
import type { RunContext } from "./types";

/**
 * Knowledge operations shared by the research, comment and chat workflows:
 * extract findings from a source → decide how they relate to stored knowledge
 * → store them with provenance → write posts from stored knowledge.
 */

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export const extractionSchema = z.object({
  relevant: z.boolean().describe("Whether this source bears on the research question at all."),
  relevanceNote: z.string(),
  studyContext: z.object({
    organism: z.string().nullable().describe("e.g. mouse, human cells, none"),
    system: z.string().nullable().describe("tissue/cell type/model"),
    intervention: z.string().nullable().describe("e.g. cyclic OSK via AAV, OSKM doxycycline-inducible"),
    design: z.string().nullable().describe("e.g. in vivo lifespan study, in vitro, review"),
    sampleSize: z.string().nullable(),
  }),
  findings: z
    .array(
      z.object({
        kind: z.enum(["claim", "observation"]).describe("observation = a measured result; claim = a proposition the source supports"),
        statement: z.string().min(10).describe("Neutral, self-contained proposition including organism/context."),
        quote: z.string().min(10).describe("EXACT verbatim sentence(s) copied from the source text that support the statement."),
        strength: z.enum(EVIDENCE_STRENGTHS).describe("How strongly this source supports the statement given its design."),
        tags: z.array(z.string()).describe("1-4 short lowercase topic tags"),
      }),
    )
    .describe("Findings relevant to the research question, most important first."),
  openQuestions: z.array(z.string()).describe("Questions this source raises but does not answer (max 2)."),
});
export type Extraction = z.infer<typeof extractionSchema>;
export type Finding = Extraction["findings"][number];

export interface ExtractedFinding extends Finding {
  sourceId: string;
}

export async function extractFromSource(
  ctx: RunContext,
  source: Source,
  text: string,
): Promise<Extraction> {
  const { limits } = ctx.settings;
  const body = text.slice(0, limits.maxSourceChars);
  const { data } = await ctx.llm.structured(
    "research_worker",
    `extract:${source.id}`,
    {
      system: researchSystemPrompt(ctx.settings),
      messages: [
        {
          role: "user",
          content: `Extract findings relevant to the research question from this source.

Rules:
- At most ${limits.maxClaimsPerSource} findings. Skip findings unrelated to reprogramming, rejuvenation, aging biomarkers, cellular identity, or cancer/teratoma risk.
- "quote" MUST be copied exactly, character for character, from the SOURCE TEXT below. Findings whose quote cannot be found verbatim will be discarded.
- The statement is your neutral paraphrase; it must not claim more than the quote supports.
- A review article's statements about other work are context, not primary evidence: use strength "weak" for them.

SOURCE: "${source.title}" (${source.sourceType}${source.publicationDate ? `, ${source.publicationDate}` : ""})
Authors: ${source.authors.slice(0, 8).join(", ") || "unknown"}
Text kind: ${String(source.metadata.textKind ?? "unknown")}

SOURCE TEXT:
"""
${body}
"""`,
        },
      ],
      maxTokens: 4096,
    },
    { name: "source_extraction", schema: extractionSchema },
  );
  return {
    ...data,
    findings: data.findings.slice(0, limits.maxClaimsPerSource),
    openQuestions: data.openQuestions.slice(0, 2),
  };
}

// ---------------------------------------------------------------------------
// Compare against existing knowledge
// ---------------------------------------------------------------------------

export const decisionSchema = z.object({
  decisions: z.array(
    z.object({
      index: z.number().int(),
      action: z
        .enum(["create", "attach", "create_and_contradict"])
        .describe(
          "create: new claim; attach: the finding is evidence about an existing node (targetId); create_and_contradict: new claim that conflicts with targetId",
        ),
      targetId: z.string().nullable(),
      evidenceType: z.enum(EVIDENCE_TYPES).describe("For attach: how the finding's quote relates to the target node."),
      rationale: z.string(),
    }),
  ),
});
export type Decision = z.infer<typeof decisionSchema>["decisions"][number];

export async function decideKnowledgeUpdates(ctx: RunContext, findings: ExtractedFinding[]): Promise<Decision[]> {
  if (findings.length === 0) return [];
  const candidates = await Promise.all(
    findings.map((f) =>
      ctx.trace(
        "search_knowledge",
        { query: f.statement },
        () =>
          ctx.deps.knowledge.searchKnowledge(f.statement, {
            types: ["claim", "hypothesis", "observation"],
            limit: 4,
            includeChunks: false,
          }),
        (r) => r.nodes.map((n) => ({ id: n.node.id, similarity: n.similarity })),
        { bookkeeping: true },
      ),
    ),
  );
  const listing = findings
    .map((f, i) => {
      const cands = candidates[i].nodes
        .map((n) => `    - id=${n.node.id} [${n.node.type}, ${n.node.status}] ${n.node.statement}`)
        .join("\n");
      return `#${i} (${f.kind}) ${f.statement}\n  quote: "${f.quote}"\n  existing candidates:\n${cands || "    (none)"}`;
    })
    .join("\n\n");

  const { data } = await ctx.llm.structured(
    "research_worker",
    "compare_with_knowledge",
    {
      system: researchSystemPrompt(ctx.settings),
      messages: [
        {
          role: "user",
          content: `For each new finding decide how it relates to existing stored knowledge.
- "attach" only if the finding is about the SAME proposition as a candidate (then choose evidenceType: supports, replicates [independent repeat of the same result], contradicts, challenges [weakens without directly contradicting], or contextualizes).
- "create_and_contradict" if it is a distinct proposition that conflicts with a candidate.
- Otherwise "create". Only use candidate ids listed under that finding.
Return exactly one decision per finding index.

${listing}`,
        },
      ],
      maxTokens: 3000,
    },
    { name: "knowledge_decisions", schema: decisionSchema },
  );

  // Validate: one decision per finding; target ids must be offered candidates.
  return findings.map((_, i) => {
    const d = data.decisions.find((x) => x.index === i);
    const allowed = new Set(candidates[i].nodes.map((n) => n.node.id));
    if (!d || (d.action !== "create" && (!d.targetId || !allowed.has(d.targetId)))) {
      return { index: i, action: "create", targetId: null, evidenceType: "supports", rationale: d ? "invalid target; created instead" : "no decision returned" };
    }
    return d;
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoreResult {
  createdNodeIds: string[];
  touchedClaimIds: string[];
  evidenceIds: string[];
  questionIds: string[];
  rejected: { statement: string; reason: string }[];
}

export function emptyStoreResult(): StoreResult {
  return { createdNodeIds: [], touchedClaimIds: [], evidenceIds: [], questionIds: [], rejected: [] };
}

function lastNames(authors: string[]): Set<string> {
  return new Set(
    authors
      .map((a) => a.replace(/,.*$/, "").trim().split(/\s+/).pop()?.toLowerCase() ?? "")
      .filter((n) => n.length > 1),
  );
}

/**
 * Deterministic independence estimate: does this source share authors with
 * sources already providing evidence on the target?
 */
async function independenceFor(ctx: RunContext, targetId: string, source: Source) {
  const k = ctx.deps.knowledge;
  const existing = [...(await k.getEvidenceForClaim(targetId)), ...(await k.getEvidenceAgainstClaim(targetId))].filter(
    (e) => e.sourceId !== source.id,
  );
  if (existing.length === 0) return "unknown" as const;
  const mine = lastNames(source.authors);
  if (mine.size === 0) return "unknown" as const;
  const overlap = existing.some((e) => [...lastNames(e.source.authors)].some((n) => mine.has(n)));
  return overlap ? ("same_group" as const) : ("independent" as const);
}

async function addEvidenceSafely(
  ctx: RunContext,
  result: StoreResult,
  input: { claimId: string; source: Source; quote: string; evidenceType: EvidenceType; strength: Finding["strength"]; notes?: string },
): Promise<boolean> {
  try {
    const independence = await independenceFor(ctx, input.claimId, input.source);
    const { evidence } = await ctx.trace(
      "add_evidence",
      { claimId: input.claimId, sourceId: input.source.id, evidenceType: input.evidenceType },
      () =>
        ctx.deps.knowledge.addEvidence({
          claimId: input.claimId,
          sourceId: input.source.id,
          quote: input.quote,
          evidenceType: input.evidenceType,
          strength: input.strength,
          independence,
          notes: input.notes,
          runId: ctx.runId,
        }),
      (r) => ({ evidenceId: r.evidence.id, created: r.created }),
      { bookkeeping: true },
    );
    result.evidenceIds.push(evidence.id);
    if (!result.touchedClaimIds.includes(input.claimId)) result.touchedClaimIds.push(input.claimId);
    return true;
  } catch (err) {
    if (err instanceof ProvenanceError) {
      result.rejected.push({ statement: input.quote.slice(0, 120), reason: err.message });
      return false;
    }
    throw err;
  }
}

/** Normalised verbatim check, used before creating a node so we never store unsupported claims. */
export function quoteAppearsIn(quote: string, text: string): boolean {
  const norm = (s: string) =>
    s
      .normalize("NFKC")
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[‐-―−]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const q = norm(quote);
  return q.length > 0 && norm(text).includes(q);
}

async function sourceText(ctx: RunContext, source: Source): Promise<string> {
  const chunks = await ctx.deps.knowledge.getSourceChunks(source.id);
  return [source.fullText ?? "", ...chunks.map((c) => c.content)].join("\n");
}

export async function applyKnowledgeUpdates(
  ctx: RunContext,
  findings: ExtractedFinding[],
  decisions: Decision[],
  result: StoreResult = emptyStoreResult(),
): Promise<StoreResult> {
  const k = ctx.deps.knowledge;
  const sources = new Map<string, { source: Source; text: string }>();

  for (const [i, f] of findings.entries()) {
    if (!sources.has(f.sourceId)) {
      const source = await k.getSource(f.sourceId);
      if (!source) throw new Error(`Source ${f.sourceId} disappeared`);
      sources.set(f.sourceId, { source, text: await sourceText(ctx, source) });
    }
    const { source, text } = sources.get(f.sourceId)!;
    if (!quoteAppearsIn(f.quote, text)) {
      result.rejected.push({ statement: f.statement, reason: "quote not found verbatim in source" });
      continue;
    }
    const d = decisions[i];

    if (d.action === "attach" && d.targetId) {
      await addEvidenceSafely(ctx, result, {
        claimId: d.targetId,
        source,
        quote: f.quote,
        evidenceType: d.evidenceType,
        strength: f.strength,
        notes: d.rationale,
      });
      continue;
    }

    const input = { statement: f.statement, tags: f.tags, runId: ctx.runId, metadata: { firstSourceId: source.id } };
    const { node, created } = await ctx.trace(
      f.kind === "observation" ? "create_observation" : "create_claim",
      { statement: f.statement },
      () => (f.kind === "observation" ? k.createObservation(input) : k.createClaim(input)),
      (r) => ({ id: r.node.id, created: r.created }),
      { bookkeeping: true },
    );
    if (created) result.createdNodeIds.push(node.id);
    await addEvidenceSafely(ctx, result, { claimId: node.id, source, quote: f.quote, evidenceType: "supports", strength: f.strength });

    if (d.action === "create_and_contradict" && d.targetId) {
      await ctx.trace(
        "link_knowledge",
        { from: node.id, to: d.targetId, type: "contradicts" },
        () =>
          k.linkKnowledge({ fromId: node.id, toId: d.targetId!, relationshipType: "contradicts", sourceId: source.id, metadata: { rationale: d.rationale } }),
        undefined,
        { bookkeeping: true },
      );
      await addEvidenceSafely(ctx, result, {
        claimId: d.targetId,
        source,
        quote: f.quote,
        evidenceType: "contradicts",
        strength: f.strength,
        notes: d.rationale,
      });
    }
  }
  return result;
}

export async function storeOpenQuestions(
  ctx: RunContext,
  questions: { statement: string; raisedBy: string[]; tags?: string[] }[],
  result: StoreResult,
): Promise<void> {
  for (const q of questions) {
    const { node, created } = await ctx.trace(
      "create_question",
      { statement: q.statement },
      () =>
        ctx.deps.knowledge.createQuestion({
          statement: q.statement,
          raisedBy: q.raisedBy,
          tags: q.tags,
          origin: "agent_generated",
          runId: ctx.runId,
        }),
      (r) => ({ id: r.node.id, created: r.created }),
      { bookkeeping: true },
    );
    if (created) result.questionIds.push(node.id);
  }
}

// ---------------------------------------------------------------------------
// Post writing
// ---------------------------------------------------------------------------

export const postSchema = z.object({
  title: z.string().min(5).max(140),
  body: z.string().min(50).describe("Markdown body with [n] citation markers. Do NOT include the source list."),
  rationale: z.string().describe("Why this is worth posting now, for the human reviewer."),
});

export type CitableSource = Pick<Source, "id" | "title" | "url" | "publicationDate">;

export interface PostMaterial {
  context: string;
  sources: CitableSource[];
  nodeIds: string[];
}

/** Gather structured knowledge + provenance for a topic, for post/reply writing. */
export async function gatherMaterial(ctx: RunContext, topic: string, focusNodeIds: string[] = []): Promise<PostMaterial> {
  const k = ctx.deps.knowledge;
  const retrieved = await ctx.trace(
    "search_knowledge",
    { query: topic },
    () => k.searchKnowledge(topic, { limit: 8, chunkLimit: 3 }),
    (r) => ({ nodes: r.nodes.length, chunks: r.chunks.length }),
    { bookkeeping: true },
  );
  const nodeIds = [...new Set([...focusNodeIds, ...retrieved.nodes.map((n) => n.node.id)])];
  const sourceMap = new Map<string, CitableSource>();
  const focusLines: string[] = [];
  for (const id of focusNodeIds) {
    const detail = await k.getClaim(id);
    if (!detail) continue;
    detail.sources.forEach((s) => sourceMap.set(s.id, s));
    focusLines.push(
      `[FOCUS ${detail.node.type.toUpperCase()} id=${id} status=${detail.node.status} confidence=${detail.node.confidence ?? "n/a"}] ${detail.node.statement}\n` +
        [...detail.supporting, ...detail.contradicting]
          .slice(0, 6)
          .map((e) => `  - (${e.evidenceType}, ${e.strength}, ${e.independence}) [SOURCE QUOTE source_id=${e.sourceId}] "${e.quote}"`)
          .join("\n"),
    );
  }
  for (const n of retrieved.nodes) n.topEvidence.forEach((e) => sourceMap.has(e.sourceId) || sourceMap.set(e.sourceId, e.source));
  for (const c of retrieved.chunks) if (!sourceMap.has(c.source.id)) sourceMap.set(c.source.id, c.source);

  const sources = [...sourceMap.values()];
  const sourceIndex = sources.map((s, i) => `[${i + 1}] source_id=${s.id} "${s.title}"`).join("\n");
  const context = [
    focusLines.join("\n\n"),
    renderKnowledgeContext(retrieved, { maxChars: 10000 }),
    `CITABLE SOURCES (cite only these, using [n]):\n${sourceIndex || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { context, sources, nodeIds };
}

/** Remove citation markers that don't refer to a provided source, and append the numbered source list. */
export function finalizeCitations(body: string, sources: CitableSource[]): { body: string; citedSourceIds: string[]; removed: number } {
  let removed = 0;
  const cited = new Set<number>();
  const cleaned = body
    .replace(/\n+#+\s*(sources|references)[\s\S]*$/i, "")
    .replace(/\[(\d+)\]/g, (m, n: string) => {
      const idx = Number(n);
      if (idx >= 1 && idx <= sources.length) {
        cited.add(idx);
        return m;
      }
      removed++;
      return "";
    })
    .trim();
  const citedSources = [...cited].sort((a, b) => a - b);
  const list = numberedSources(sources).split("\n").filter((_, i) => cited.has(i + 1));
  return {
    body: list.length ? `${cleaned}\n\n**Sources**\n${list.join("\n")}` : cleaned,
    citedSourceIds: citedSources.map((i) => sources[i - 1].id),
    removed,
  };
}

export async function composePost(
  ctx: RunContext,
  input: {
    topic: string;
    angle?: string;
    material: PostMaterial;
    previous?: { title: string; body: string };
    feedback?: string;
    postType?: "discussion" | "claim";
  },
): Promise<{ title: string; body: string; rationale: string; citedSourceIds: string[] }> {
  const parts = [
    `Write a short research update post for the LENS project.`,
    `Topic: ${input.topic}`,
    input.angle ? `Angle: ${input.angle}` : "",
    `Use ONLY the knowledge below. Cite sources with [n] using the CITABLE SOURCES numbering. Distinguish clearly what sources report from what LENS infers. State what remains unresolved.`,
    input.postType === "claim"
      ? `This will be published as a CLAIM: posting it automatically opens a public peer review where other researchers vote on whether it is scientifically sound. The body MUST:
- State the claim as ONE falsifiable sentence.
- Give the reasoning behind it.
- Include an explicit falsification test: the specific observation or experiment that would confirm or refute the claim. Label this line clearly, e.g. "Test/falsification: ...".
- Cite sources with [n] that support this specific claim, not merely sources that are on-topic.`
      : "",
    input.previous ? `PREVIOUS DRAFT:\nTitle: ${input.previous.title}\n${input.previous.body}` : "",
    input.feedback ? `OPERATOR FEEDBACK (address this):\n${input.feedback}` : "",
    `KNOWLEDGE:\n${input.material.context}`,
  ].filter(Boolean);
  const { data } = await ctx.llm.structured(
    "post_writer",
    "write_post",
    { system: postWriterSystemPrompt(ctx.settings), messages: [{ role: "user", content: parts.join("\n\n") }], maxTokens: 3000 },
    { name: "post_draft", schema: postSchema },
  );
  const cited = finalizeCitations(data.body, input.material.sources);
  return { title: data.title, body: cited.body, rationale: data.rationale, citedSourceIds: cited.citedSourceIds };
}

export async function draftPost(
  ctx: RunContext,
  input: { topic: string; angle?: string; rationale?: string; focusNodeIds?: string[]; postType?: "discussion" | "claim" },
): Promise<Post> {
  const material = await gatherMaterial(ctx, input.topic, input.focusNodeIds);
  const written = await composePost(ctx, { topic: input.topic, angle: input.angle, material, postType: input.postType });
  const ref = ctx.llm.modelFor("post_writer");
  return ctx.trace(
    "draft_post",
    { topic: input.topic },
    () =>
      createPost({
        title: written.title,
        body: written.body,
        status: "awaiting_review",
        taskId: ctx.task?.id ?? null,
        runId: ctx.runId,
        metadata: {
          rationale: [input.rationale, written.rationale].filter(Boolean).join("\n\n"),
          topic: input.topic,
          sourceIds: written.citedSourceIds,
          nodeIds: material.nodeIds,
          provider: ref.provider,
          model: ref.model,
          revisions: [],
          // Suggested type for the publish panel/publisher to default to; the
          // operator can still override it (see publishDraft in approvals/service.ts,
          // which reads metadata.openlabs as Partial<PublishHints>).
          ...(input.postType ? { openlabs: { type: input.postType } } : {}),
        },
      }),
    (p) => ({ postId: p.id }),
    { bookkeeping: true },
  );
}
