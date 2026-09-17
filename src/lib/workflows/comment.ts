import { z } from "zod";
import { getComment, updateComment } from "@/lib/repo/comments";
import { getPost } from "@/lib/repo/posts";
import { createReply } from "@/lib/repo/replies";
import { COMMENT_CLASSIFICATIONS, type CommentClassification } from "@/lib/types";
import {
  applyKnowledgeUpdates,
  decideKnowledgeUpdates,
  emptyStoreResult,
  extractFromSource,
  finalizeCitations,
  gatherMaterial,
  storeOpenQuestions,
  type ExtractedFinding,
  type StoreResult,
} from "./knowledge-ops";
import { commentSystemPrompt } from "./prompts";
import type { BaseState, RunContext, WorkflowDefinition } from "./types";

/**
 * Loop 2: Comment → Knowledge → Reply.
 *
 *   classify → research (bounded, optional) → update_knowledge → draft_reply (retrieves knowledge)
 *
 * Task input: { commentId }
 */

export interface CommentState extends BaseState {
  commentId: string;
  postId?: string;
  classification?: {
    type: CommentClassification;
    summary: string;
    needsResearch: boolean;
    researchQuery: string | null;
    citedUrls: string[];
    newDirection: string | null;
  };
  research?: { sourceIds: string[]; failures: string[] };
  stored?: StoreResult;
  replyId?: string | null;
}

const classifySchema = z.object({
  type: z.enum(COMMENT_CLASSIFICATIONS),
  summary: z.string().describe("One-sentence neutral summary of what the commenter says or asks."),
  needsResearch: z.boolean().describe("True if answering well requires literature beyond what is likely already stored."),
  researchQuery: z.string().nullable().describe("A literature search query if research is needed."),
  citedUrls: z.array(z.string()).describe("URLs or DOIs the commenter cites, verbatim."),
  newDirection: z.string().nullable().describe("If the comment suggests a new research direction, phrase it as an open question."),
});

async function loadThread(state: CommentState) {
  const comment = await getComment(state.commentId);
  if (!comment) throw new Error(`Comment ${state.commentId} not found`);
  const post = await getPost(comment.postId);
  if (!post) throw new Error(`Post ${comment.postId} not found`);
  return { comment, post };
}

function quoteComment(author: string, body: string): string {
  return `<comment author="${author.replace(/"/g, "'")}">\n${body}\n</comment>`;
}

async function classify(state: CommentState, ctx: RunContext): Promise<Partial<CommentState>> {
  const { comment, post } = await loadThread(state);
  const { data } = await ctx.llm.structured(
    "comment_reply",
    "classify_comment",
    {
      system: commentSystemPrompt(ctx.settings),
      messages: [
        {
          role: "user",
          content: `Classify this comment on our post "${post.title}".

POST:
${post.body.slice(0, 4000)}

${quoteComment(comment.author, comment.body)}

Types: question, criticism, supporting_evidence, contradictory_evidence, new_direction, noise (spam, off-topic, or content-free).`,
        },
      ],
      maxTokens: 800,
    },
    { name: "comment_classification", schema: classifySchema },
  );
  const urls = data.citedUrls.filter((u) => /^https?:\/\//.test(u)).slice(0, 2);
  await updateComment(comment.id, { classification: data.type, metadata: { ...comment.metadata, summary: data.summary } });
  const classification = { ...data, citedUrls: urls };
  if (data.type === "noise" && !ctx.settings.comment_agent.replyToNoise) {
    await updateComment(comment.id, { processedAt: new Date().toISOString() });
    return { postId: post.id, classification, halted: "comment classified as noise; no reply drafted", replyId: null };
  }
  return { postId: post.id, classification };
}

async function research(state: CommentState, ctx: RunContext): Promise<Partial<CommentState>> {
  const c = state.classification!;
  const policy = ctx.settings.comment_agent.researchBeforeReply;
  const budget = ctx.settings.limits.maxFollowUpResearch;
  const wanted = policy === "always" || (policy === "when_needed" && (c.needsResearch || c.citedUrls.length > 0));
  if (!wanted || budget === 0) return { research: { sourceIds: [], failures: [] } };

  const sourceIds: string[] = [];
  const failures: string[] = [];
  const store = async (doc: Parameters<typeof ctx.deps.knowledge.upsertSource>[0]) => {
    const { source } = await ctx.trace("store_source", { title: doc.title }, () =>
      ctx.deps.knowledge.upsertSource({ ...doc, maxChars: ctx.settings.limits.maxSourceChars }),
    );
    sourceIds.push(source.id);
  };

  // Budget = max number of extra sources fetched for one comment.
  // 1. Sources the commenter cited.
  for (const url of c.citedUrls.slice(0, budget)) {
    try {
      await store(await ctx.trace("fetch_url", { url }, () => ctx.deps.fetchUrl(url)));
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 2. A single literature search with the remaining budget.
  const query = c.researchQuery;
  if (query && sourceIds.length < budget) {
    for (const source of ctx.deps.getResearchSources(ctx.settings.project.enabledSources)) {
      if (sourceIds.length >= budget) break;
      try {
        const results = await ctx.trace(`research_search:${source.id}`, { query }, () => source.search({ query, limit: 3 }));
        for (const r of results) {
          if (sourceIds.length >= budget) break;
          if (await ctx.deps.knowledge.findSource({ doi: r.doi, url: r.url })) continue;
          await store(await ctx.trace(`research_fetch:${source.id}`, { title: r.title }, () => source.fetch(r)));
        }
      } catch (err) {
        failures.push(`${source.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { research: { sourceIds, failures } };
}

async function updateKnowledge(state: CommentState, ctx: RunContext): Promise<Partial<CommentState>> {
  const { comment, post } = await loadThread(state);
  const c = state.classification!;
  const k = ctx.deps.knowledge;
  const stored = emptyStoreResult();

  // Evidence can only come from real sources fetched in the research step — never from the comment text itself.
  const findings: ExtractedFinding[] = [];
  for (const sourceId of state.research?.sourceIds ?? []) {
    const source = await k.getSource(sourceId);
    if (!source) continue;
    const chunks = await k.getSourceChunks(sourceId);
    const extraction = await extractFromSource(ctx, source, source.fullText ?? chunks.map((ch) => ch.content).join("\n\n"));
    if (extraction.relevant) findings.push(...extraction.findings.map((f) => ({ ...f, sourceId })));
  }
  if (findings.length) {
    await applyKnowledgeUpdates(ctx, findings, await decideKnowledgeUpdates(ctx, findings), stored);
  }

  // The comment itself is recorded as a source for provenance of any question it raised.
  if (c.type === "new_direction" || c.type === "criticism" || c.type === "contradictory_evidence") {
    await ctx.trace("store_comment_source", { commentId: comment.id }, () =>
      k.upsertSource({
        title: `Comment by ${comment.author} on "${post.title}"`,
        url: null,
        doi: null,
        authors: [comment.author],
        publicationDate: comment.createdAt.slice(0, 10),
        sourceType: "comment",
        text: comment.body,
        textKind: "snippet",
        metadata: { commentId: comment.id, postId: post.id },
      }),
    );
    const statement =
      c.newDirection ?? `Commenter raises (${c.type.replace("_", " ")}): ${c.summary} — does stored evidence address this?`;
    await storeOpenQuestions(
      ctx,
      [{ statement, raisedBy: (post.metadata.nodeIds ?? []).slice(0, 3), tags: ["from-comment"] }],
      stored,
    );
  }
  return { stored };
}

const replySchema = z.object({
  body: z.string().min(1).describe("The reply text with [n] citation markers where sources are used. No source list."),
  rationale: z.string().describe("For the human reviewer: why this reply, and what was learned."),
  knowledgeChanged: z.boolean(),
});

async function draftReply(state: CommentState, ctx: RunContext): Promise<Partial<CommentState>> {
  const { comment, post } = await loadThread(state);
  const c = state.classification!;
  const material = await gatherMaterial(ctx, `${c.summary}\n${comment.body.slice(0, 500)}`, [
    ...(state.stored?.touchedClaimIds ?? []),
  ]);
  const learned = state.stored
    ? `Knowledge updates from this comment: ${state.stored.createdNodeIds.length} nodes created, ${state.stored.evidenceIds.length} evidence items, ${state.stored.questionIds.length} questions.`
    : "";
  const { data } = await ctx.llm.structured(
    "comment_reply",
    "draft_reply",
    {
      system: commentSystemPrompt(ctx.settings),
      messages: [
        {
          role: "user",
          content: `Draft a reply to this ${c.type.replace("_", " ")} on our post.

POST "${post.title}":
${post.body.slice(0, 3000)}

${quoteComment(comment.author, comment.body)}

${learned}
${state.research?.failures.length ? `Could not retrieve: ${state.research.failures.join("; ")}` : ""}

KNOWLEDGE:
${material.context}

Keep it under ${ctx.settings.comment_agent.maxResponseWords} words. If the commenter is right, say so. If the evidence is unresolved, say so.`,
        },
      ],
      maxTokens: 1500,
    },
    { name: "comment_reply", schema: replySchema },
  );
  const cited = finalizeCitations(data.body, material.sources);
  const ref = ctx.llm.modelFor("comment_reply");
  const reply = await ctx.trace(
    "draft_reply",
    { commentId: comment.id },
    () =>
      createReply({
        commentId: comment.id,
        postId: post.id,
        body: cited.body,
        status: "awaiting_review",
        taskId: ctx.task?.id ?? null,
        runId: ctx.runId,
        metadata: {
          rationale: data.rationale,
          classification: c.type,
          commentSummary: c.summary,
          knowledgeChanged: data.knowledgeChanged,
          sourceIds: cited.citedSourceIds,
          nodeIds: material.nodeIds,
          provider: ref.provider,
          model: ref.model,
          revisions: [],
        },
      }),
    (r) => ({ replyId: r.id }),
  );
  await updateComment(comment.id, { processedAt: new Date().toISOString() });
  return { replyId: reply.id };
}

export const commentWorkflow: WorkflowDefinition<CommentState> = {
  name: "comment_reply",
  primaryModel: "comment_reply",
  initialState: (task) => ({ commentId: String(task.input.commentId ?? "") }),
  steps: [
    { name: "classify", run: classify, summarize: (s) => `${s.classification?.type}: ${s.classification?.summary}` },
    {
      name: "research",
      run: research,
      summarize: (s) => `${s.research?.sourceIds.length ?? 0} sources fetched, ${s.research?.failures.length ?? 0} failures`,
    },
    {
      name: "update_knowledge",
      run: updateKnowledge,
      summarize: (s) => `${s.stored?.createdNodeIds.length ?? 0} nodes, ${s.stored?.evidenceIds.length ?? 0} evidence, ${s.stored?.questionIds.length ?? 0} questions`,
    },
    { name: "draft_reply", run: draftReply, summarize: (s) => (s.replyId ? `reply ${s.replyId}` : "no reply") },
  ],
  finalStatus: (s) => (s.replyId ? "awaiting_approval" : "completed"),
  output: (s) => ({
    classification: s.classification?.type ?? null,
    replyId: s.replyId ?? null,
    createdNodeIds: s.stored?.createdNodeIds ?? [],
    questionIds: s.stored?.questionIds ?? [],
  }),
};
