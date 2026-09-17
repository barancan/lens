import { z } from "zod";
import { renderKnowledgeContext } from "@/lib/knowledge/retrieval";
import type { SearchResult } from "@/lib/research/types";
import { listTasks } from "@/lib/repo/tasks";
import type { KnowledgeNode } from "@/lib/types";
import { openlabsSchema, type Settings } from "@/lib/settings/schema";
import {
  applyKnowledgeUpdates,
  decideKnowledgeUpdates,
  draftPost,
  emptyStoreResult,
  extractFromSource,
  storeOpenQuestions,
  type ExtractedFinding,
  type StoreResult,
} from "./knowledge-ops";
import { researchSystemPrompt } from "./prompts";
import { LimitExceededError, type BaseState, type RunContext, type WorkflowDefinition } from "./types";

/**
 * Loop 1: Research → Knowledge → Post.
 *
 *   plan → search → select → read → extract → compare → store → synthesize → draft
 *
 * Task input: { objective: string (task.objective), urls?: string[] }
 */

export interface ResearchInput {
  urls?: string[];
}

interface Candidate extends SearchResult {
  key: string;
}

interface ReadSource {
  sourceId: string;
  title: string;
  textKind: string;
  newlyStored: boolean;
}

export interface ResearchState extends BaseState {
  objective: string;
  urls: string[];
  plan?: { rationale: string; subQuestions: string[]; queries: string[] };
  candidates?: Candidate[];
  selected?: { key: string; reason: string }[];
  read?: ReadSource[];
  readFailures?: { title: string; error: string }[];
  findings?: ExtractedFinding[];
  sourceQuestions?: { statement: string; sourceId: string }[];
  irrelevantSourceIds?: string[];
  decisions?: Awaited<ReturnType<typeof decideKnowledgeUpdates>>;
  stored?: StoreResult;
  synthesis?: Synthesis;
  postId?: string | null;
  /** Findings the operator queued for drill-down that this run picked up. */
  drillDownNodeIds?: string[];
  impactRecomputed?: number;
}

function depthFactor(ctx: RunContext): number {
  return { shallow: 0.5, standard: 1, deep: 1.5 }[ctx.settings.research_agent.researchDepth];
}

function resultKey(r: SearchResult): string {
  if (r.doi) return `doi:${r.doi.toLowerCase()}`;
  if (r.url) return `url:${r.url}`;
  return `title:${r.title.toLowerCase().replace(/\W+/g, " ").trim()}`;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const planSchema = z.object({
  rationale: z.string().describe("Why these sub-questions are the most valuable next step."),
  subQuestions: z.array(z.string()).min(1).max(4),
  queries: z
    .array(z.string())
    .min(1)
    .describe("Literature search queries: short keyword/boolean queries suitable for Europe PMC / Crossref."),
});

async function plan(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  const k = ctx.deps.knowledge;
  const [openQuestions, contested, stats, recent, drillDown] = await Promise.all([
    k.listNodes({ types: ["question"], statuses: ["open"], limit: 15 }),
    k.listNodes({ types: ["claim"], statuses: ["contested", "weak", "unresolved"], limit: 10 }),
    k.stats(),
    listTasks({ types: ["research"], limit: 8 }),
    k.listDrillDownQueue(ctx.settings.limits.maxDrillDownTargets),
  ]);
  const context = await ctx.trace(
    "search_knowledge",
    { query: state.objective },
    () => k.searchKnowledge(state.objective, { limit: 8, includeChunks: false }),
    (r) => ({ nodes: r.nodes.length }),
    { bookkeeping: true },
  );
  const { data } = await ctx.llm.structured(
    "research_planner",
    "plan",
    {
      system: researchSystemPrompt(ctx.settings),
      messages: [
        {
          role: "user",
          content: `Plan the next bounded research iteration.

OBJECTIVE: ${state.objective}
${renderDrillDownRequests(drillDown)}
Knowledge base: ${stats.nodesByType.claim} claims, ${stats.nodesByType.question} questions, ${stats.sources} sources, ${stats.evidence} evidence items.

OPEN QUESTIONS:
${openQuestions.map((q) => `- ${q.statement}`).join("\n") || "(none)"}

CLAIMS NEEDING WORK (contested / weak / unresolved):
${contested.map((c) => `- [${c.status}] ${c.statement}`).join("\n") || "(none)"}

RECENT RESEARCH OBJECTIVES (avoid repeating):
${recent.filter((t) => t.id !== ctx.task?.id).map((t) => `- ${t.objective}`).join("\n") || "(none)"}

RELATED STORED KNOWLEDGE:
${renderKnowledgeContext(context, { maxChars: 5000 })}

Produce 1-4 sub-questions and at most ${ctx.settings.limits.maxQueriesPerRun} search queries. Prefer queries likely to surface primary research, independent replications, and safety (tumorigenesis/teratoma) data.${
            drillDown.length > 0
              ? "\n\nAt least one sub-question and one search query MUST target the first operator drill-down request above."
              : ""
          }`,
        },
      ],
      maxTokens: 2000,
    },
    { name: "research_plan", schema: planSchema },
  );
  return {
    plan: { ...data, queries: data.queries.slice(0, ctx.settings.limits.maxQueriesPerRun) },
    drillDownNodeIds: drillDown.map((n) => n.id),
  };
}

/**
 * The operator's explicit steering, rendered above everything else the planner
 * sees. This is the only path by which the impact score changes what the agent
 * does — the score itself never silently reorders the agent's own priorities.
 */
function renderDrillDownRequests(nodes: KnowledgeNode[]): string {
  if (nodes.length === 0) return "";
  const lines = nodes.map((n) => {
    const impact = n.impact != null ? `, impact ${n.impact.toFixed(2)}` : "";
    const note = n.drillDownNote ? `\n  operator note: ${n.drillDownNote}` : "";
    return `- [${n.type}, ${n.status}${impact}] ${n.statement}${note}`;
  });
  return `
OPERATOR DRILL-DOWN REQUESTS (highest priority — the operator has explicitly asked that these be pushed forward this cycle):
${lines.join("\n")}
`;
}

async function search(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  const sources = ctx.deps.getResearchSources(ctx.settings.project.enabledSources);
  const limit = ctx.settings.limits.maxResultsPerQuery;
  const seen = new Map<string, Candidate>();

  for (const url of state.urls) {
    const r: SearchResult = {
      sourceId: "url",
      externalId: url,
      title: url,
      url,
      doi: null,
      authors: [],
      publicationDate: null,
      sourceType: "web_page",
      snippet: "Operator-provided URL",
      metadata: {},
    };
    seen.set(resultKey(r), { ...r, key: resultKey(r) });
  }

  for (const query of state.plan?.queries ?? []) {
    for (const source of sources) {
      try {
        const results = await ctx.trace(
          `research_search:${source.id}`,
          { query, limit },
          () => source.search({ query, limit }),
          (rs) => ({ count: rs.length, titles: rs.slice(0, 5).map((r) => r.title) }),
        );
        for (const r of results) {
          const key = resultKey(r);
          if (!seen.has(key)) seen.set(key, { ...r, key });
        }
      } catch (err) {
        // Logged by trace; one failing source should not end the run, but an exhausted budget should.
        if (err instanceof LimitExceededError) throw err;
      }
    }
  }

  // Drop results already stored in the knowledge base (unless explicitly requested by URL).
  const candidates: Candidate[] = [];
  for (const c of seen.values()) {
    const existing = c.sourceId === "url" ? null : await ctx.deps.knowledge.findSource({ doi: c.doi, url: c.url });
    if (!existing) candidates.push(c);
  }
  if (candidates.length === 0) return { candidates, halted: "no new sources found" };
  return { candidates };
}

const selectSchema = z.object({
  selected: z.array(z.object({ index: z.number().int(), reason: z.string() })),
});

async function select(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  const candidates = state.candidates ?? [];
  const max = Math.max(1, Math.round(ctx.settings.limits.maxSourcesPerRun * depthFactor(ctx)));
  const forced = candidates.filter((c) => c.sourceId === "url").map((c) => ({ key: c.key, reason: "operator-provided URL" }));
  const pool = candidates.filter((c) => c.sourceId !== "url");
  if (pool.length === 0 || forced.length >= max) return { selected: forced.slice(0, max) };

  const listing = pool
    .map(
      (c, i) =>
        `#${i} [${c.sourceType}${c.publicationDate ? `, ${c.publicationDate.slice(0, 4)}` : ""}] ${c.title}\n   ${(c.snippet ?? "").slice(0, 300)}`,
    )
    .join("\n");
  const { data } = await ctx.llm.structured(
    "research_worker",
    "select_sources",
    {
      system: researchSystemPrompt(ctx.settings),
      messages: [
        {
          role: "user",
          content: `Objective: ${state.objective}
Sub-questions:\n${(state.plan?.subQuestions ?? []).map((q) => `- ${q}`).join("\n")}

Choose up to ${max - forced.length} of the candidates most likely to provide primary evidence for the sub-questions. Prefer primary research over reviews, and include safety-relevant work.

${listing}`,
        },
      ],
      maxTokens: 1500,
    },
    { name: "source_selection", schema: selectSchema },
  );
  const chosen = data.selected
    .filter((s) => s.index >= 0 && s.index < pool.length)
    .filter((s, i, arr) => arr.findIndex((x) => x.index === s.index) === i)
    .slice(0, max - forced.length)
    .map((s) => ({ key: pool[s.index].key, reason: s.reason }));
  const selected = [...forced, ...chosen];
  if (selected.length === 0) return { selected, halted: "no relevant sources selected" };
  return { selected };
}

async function read(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  const byKey = new Map((state.candidates ?? []).map((c) => [c.key, c]));
  const adapters = new Map(ctx.deps.getResearchSources(ctx.settings.project.enabledSources).map((s) => [s.id, s]));
  const readSources: ReadSource[] = [];
  const failures: { title: string; error: string }[] = [];

  for (const { key } of state.selected ?? []) {
    const candidate = byKey.get(key);
    if (!candidate) continue;
    try {
      const doc = await ctx.trace(
        `research_fetch:${candidate.sourceId}`,
        { title: candidate.title, url: candidate.url, doi: candidate.doi },
        async () => {
          if (candidate.sourceId === "url") return ctx.deps.fetchUrl(candidate.url!);
          const adapter = adapters.get(candidate.sourceId);
          if (!adapter) throw new Error(`Research source ${candidate.sourceId} is not enabled`);
          return adapter.fetch(candidate);
        },
        (d) => ({ title: d.title, textKind: d.textKind, chars: d.text.length }),
      );
      const { source, created } = await ctx.trace(
        "store_source",
        { title: doc.title },
        () => ctx.deps.knowledge.upsertSource({ ...doc, maxChars: ctx.settings.limits.maxSourceChars }),
        (r) => ({ sourceId: r.source.id, created: r.created, chunks: r.chunks.length }),
    { bookkeeping: true },
      );
      readSources.push({ sourceId: source.id, title: source.title, textKind: doc.textKind, newlyStored: created });
    } catch (err) {
      if (err instanceof LimitExceededError) throw err;
      failures.push({ title: candidate.title, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (readSources.length === 0) return { read: readSources, readFailures: failures, halted: "no sources could be read" };
  return { read: readSources, readFailures: failures };
}

async function extract(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  const findings: ExtractedFinding[] = [];
  const questions: { statement: string; sourceId: string }[] = [];
  const irrelevant: string[] = [];
  for (const r of state.read ?? []) {
    const source = await ctx.deps.knowledge.getSource(r.sourceId);
    if (!source) continue;
    const chunks = await ctx.deps.knowledge.getSourceChunks(source.id);
    const text = source.fullText ?? chunks.map((c) => c.content).join("\n\n");
    const extraction = await extractFromSource(ctx, source, text);
    if (!extraction.relevant) {
      irrelevant.push(source.id);
      continue;
    }
    findings.push(...extraction.findings.map((f) => ({ ...f, sourceId: source.id })));
    questions.push(...extraction.openQuestions.map((q) => ({ statement: q, sourceId: source.id })));
  }
  return { findings, sourceQuestions: questions, irrelevantSourceIds: irrelevant };
}

async function compare(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  return { decisions: await decideKnowledgeUpdates(ctx, state.findings ?? []) };
}

async function store(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  const findings = state.findings ?? [];
  const result = await applyKnowledgeUpdates(ctx, findings, state.decisions ?? [], emptyStoreResult());
  // Questions raised by a source are linked to nodes created from that source.
  const nodesBySource = new Map<string, string[]>();
  for (const [i, f] of findings.entries()) {
    const d = state.decisions?.[i];
    const id = d?.action === "attach" ? d.targetId : null;
    if (id) nodesBySource.set(f.sourceId, [...(nodesBySource.get(f.sourceId) ?? []), id]);
  }
  for (const id of result.createdNodeIds) {
    const node = await ctx.deps.knowledge.getNode(id);
    const sourceId = node?.metadata.firstSourceId as string | undefined;
    if (sourceId) nodesBySource.set(sourceId, [...(nodesBySource.get(sourceId) ?? []), id]);
  }
  await storeOpenQuestions(
    ctx,
    (state.sourceQuestions ?? []).map((q) => ({ statement: q.statement, raisedBy: (nodesBySource.get(q.sourceId) ?? []).slice(0, 3) })),
    result,
  );
  // Only now that knowledge has actually been written do we count the
  // operator's drill-down requests as acted on. Clearing them in `plan` would
  // silently lose the request if the run failed later; a failed run leaves them
  // queued for the next cycle instead.
  if (state.drillDownNodeIds?.length) {
    await ctx.trace(
      "consume_drill_down",
      { nodeIds: state.drillDownNodeIds },
      () => ctx.deps.knowledge.markDrillDownConsumed(state.drillDownNodeIds!),
      undefined,
      { bookkeeping: true },
    );
  }

  return { stored: result };
}

const synthesisSchema = z.object({
  summary: z.string().describe("What this iteration changed in our understanding (for the run log). One paragraph."),
  insights: z
    .array(
      z.object({
        statement: z.string().describe("An interpretation LENS draws by combining stored knowledge. Must be labelled as interpretation, hedged."),
        derivedFrom: z.array(z.string()).min(1).describe("Node ids this insight is derived from"),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(3),
  questions: z
    .array(z.object({ statement: z.string(), raisedBy: z.array(z.string()) }))
    .max(3),
  postWorthy: z.boolean().describe("True only if there is a genuinely informative update for readers."),
  // The post fields only matter when postWorthy is true, so they are optional: a
  // synthesis that declines to post (or is cut short) must not lose its insights.
  postTopic: z.string().optional().describe("If postWorthy: the topic of the public research update."),
  postAngle: z.string().optional().describe("If postWorthy: the angle the post should take."),
  postRationale: z.string().optional().describe("If postWorthy: why this warrants a public update now."),
  postType: openlabsSchema.shape.defaultPostType
    .optional()
    .describe(
      "If postWorthy: which post type to suggest. Choose \"claim\" ONLY when the update is a specific, testable proposition you can state a falsification test for. " +
        "Choose \"discussion\" otherwise (open questions, synthesis, framing). Bias toward \"discussion\": our epistemic guardrails already prefer " +
        "hedged, evidence-proportional language, and a claim automatically opens a public peer review.",
    ),
  focusNodeIds: z.array(z.string()).max(6).optional().describe("If postWorthy: up to 6 node ids the post should centre on."),
});

/**
 * Persisted synthesis. Post fields are normalised in `synthesize`: whenever
 * `postWorthy` is true there is a topic (falling back to the run objective), a
 * post type (falling back to the operator's OpenLabs default) and focus nodes
 * (falling back to what this run touched).
 */
interface Synthesis extends Omit<z.infer<typeof synthesisSchema>, "postType" | "focusNodeIds"> {
  postType: Settings["openlabs"]["defaultPostType"];
  focusNodeIds: string[];
}

async function synthesize(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  const stored = state.stored ?? emptyStoreResult();
  const k = ctx.deps.knowledge;
  const touched = (
    await Promise.all([...new Set([...stored.touchedClaimIds, ...stored.createdNodeIds])].map((id) => k.getNode(id)))
  ).filter((n) => n !== null);
  if (touched.length === 0) {
    return { halted: "no new knowledge stored", synthesis: undefined };
  }
  const context = await ctx.trace(
    "search_knowledge",
    { query: state.objective },
    () => k.searchKnowledge(state.objective, { limit: 10, chunkLimit: 3 }),
    (r) => ({ nodes: r.nodes.length }),
    { bookkeeping: true },
  );
  const allowed = new Set([...touched.map((n) => n.id), ...context.nodes.map((n) => n.node.id)]);
  const touchedLines = touched
    .map((n) => `- id=${n.id} [${n.type}, ${n.status}, confidence=${n.confidence ?? "n/a"}] ${n.statement}`)
    .join("\n");

  const { data } = await ctx.llm.structured(
    "research_synthesis",
    "synthesize",
    {
      system: researchSystemPrompt(ctx.settings),
      messages: [
        {
          role: "user",
          content: `Objective of this iteration: ${state.objective}

KNOWLEDGE ADDED OR UPDATED THIS RUN:
${touchedLines}

WIDER STORED KNOWLEDGE:
${renderKnowledgeContext(context, { maxChars: 8000 })}

Tasks:
1. Propose at most 3 insights: interpretations that connect stored nodes (e.g. tension between efficacy and safety findings, gaps in replication, model-organism limits). Each must cite derivedFrom node ids from the lists above. Do not restate a single claim as an insight.
2. Propose at most 3 new open questions, with raisedBy node ids.
3. Decide whether this warrants a public research update (postWorthy). If yes, also give postTopic, postAngle, postRationale, postType and up to 6 focusNodeIds; if no, omit them.`,
        },
      ],
      maxTokens: 6000,
    },
    { name: "research_synthesis", schema: synthesisSchema },
  );

  const valid = (ids: string[]) => ids.filter((id) => allowed.has(id));
  for (const insight of data.insights) {
    const derivedFrom = valid(insight.derivedFrom);
    if (derivedFrom.length === 0) continue;
    const { node, created } = await ctx.trace(
      "create_insight",
      { statement: insight.statement },
      () => k.createInsight({ statement: insight.statement, derivedFrom, confidence: insight.confidence, runId: ctx.runId }),
      (r) => ({ id: r.node.id, created: r.created }),
    { bookkeeping: true },
    );
    if (created) stored.createdNodeIds.push(node.id);
  }
  await storeOpenQuestions(
    ctx,
    data.questions.map((q) => ({ statement: q.statement, raisedBy: valid(q.raisedBy) })),
    stored,
  );

  // Post fields are only meaningful when postWorthy; fill in transparent defaults
  // rather than failing the step. The draft still goes to the approval queue.
  const synthesis: Synthesis = {
    ...data,
    postType: data.postType ?? ctx.settings.openlabs.defaultPostType,
    focusNodeIds: valid(data.focusNodeIds ?? []),
  };
  if (synthesis.postWorthy) {
    synthesis.postTopic = data.postTopic?.trim() || state.objective;
    if (synthesis.focusNodeIds.length === 0) synthesis.focusNodeIds = touched.slice(0, 6).map((n) => n.id);
  }
  return { synthesis, stored };
}

async function draft(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  const s = state.synthesis;
  if (!s?.postWorthy || !s.postTopic) return { postId: null };
  const post = await draftPost(ctx, {
    topic: s.postTopic,
    angle: s.postAngle,
    rationale: [`Research objective: ${state.objective}`, s.postRationale].filter(Boolean).join("\n"),
    focusNodeIds: s.focusNodeIds,
    postType: s.postType,
  });
  return { postId: post.id };
}

/**
 * Rescores impact for everything this run touched, plus their 1-hop
 * neighbours — the correct staleness boundary, since a node's status change
 * alters the reach of whatever points at it but not of nodes two hops away.
 *
 * Runs after `synthesize` rather than after `draft` so a drafting failure
 * cannot leave the scores stale, and `synthesize` may halt the run when
 * nothing was stored (in which case there is nothing to rescore anyway).
 */
async function assessImpact(state: ResearchState, ctx: RunContext): Promise<Partial<ResearchState>> {
  const stored = state.stored;
  const ids = [
    ...new Set([...(stored?.createdNodeIds ?? []), ...(stored?.touchedClaimIds ?? []), ...(stored?.questionIds ?? [])]),
  ];
  if (ids.length === 0) return { impactRecomputed: 0 };

  const impactRecomputed = await ctx.trace(
    "recompute_impact",
    { nodeIds: ids.length },
    () => ctx.deps.knowledge.recomputeImpact(ids, { includeNeighbours: true }),
    (count) => ({ count }),
    { bookkeeping: true },
  );
  return { impactRecomputed };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const urlsSchema = z.array(z.url()).max(5);

export const researchWorkflow: WorkflowDefinition<ResearchState> = {
  name: "research",
  primaryModel: "research_planner",
  initialState: (task) => ({
    objective: task.objective,
    urls: urlsSchema.catch([]).parse(task.input.urls ?? []),
  }),
  steps: [
    { name: "plan", run: plan, summarize: (s) => `${s.plan?.queries.length ?? 0} queries: ${s.plan?.queries.join(" | ")}` },
    { name: "search", run: search, summarize: (s) => `${s.candidates?.length ?? 0} new candidate sources` },
    { name: "select", run: select, summarize: (s) => `${s.selected?.length ?? 0} selected` },
    { name: "read", run: read, summarize: (s) => `${s.read?.length ?? 0} read, ${s.readFailures?.length ?? 0} failed` },
    {
      name: "extract",
      run: extract,
      summarize: (s) => `${s.findings?.length ?? 0} findings, ${s.irrelevantSourceIds?.length ?? 0} irrelevant sources`,
    },
    { name: "compare", run: compare, summarize: (s) => (s.decisions ?? []).map((d) => d.action).join(", ") || "nothing to compare" },
    {
      name: "store",
      run: store,
      summarize: (s) =>
        `${s.stored?.createdNodeIds.length ?? 0} nodes created, ${s.stored?.evidenceIds.length ?? 0} evidence, ${s.stored?.questionIds.length ?? 0} questions, ${s.stored?.rejected.length ?? 0} rejected`,
    },
    {
      name: "synthesize",
      run: synthesize,
      summarize: (s) => (s.synthesis ? `${s.synthesis.summary} (postWorthy=${s.synthesis.postWorthy})` : (s.halted ?? "")),
    },
    {
      name: "assess_impact",
      run: assessImpact,
      summarize: (s) => `impact rescored for ${s.impactRecomputed ?? 0} findings`,
    },
    { name: "draft", run: draft, summarize: (s) => (s.postId ? `draft post ${s.postId}` : "no post drafted") },
  ],
  finalStatus: (s) => (s.postId ? "awaiting_approval" : "completed"),
  output: (s) => ({
    summary: s.synthesis?.summary ?? null,
    sourcesRead: s.read?.map((r) => ({ id: r.sourceId, title: r.title })) ?? [],
    createdNodeIds: s.stored?.createdNodeIds ?? [],
    touchedClaimIds: s.stored?.touchedClaimIds ?? [],
    evidenceIds: s.stored?.evidenceIds ?? [],
    questionIds: s.stored?.questionIds ?? [],
    rejectedFindings: s.stored?.rejected ?? [],
    drillDownNodeIds: s.drillDownNodeIds ?? [],
    impactRecomputed: s.impactRecomputed ?? 0,
    postId: s.postId ?? null,
  }),
};
