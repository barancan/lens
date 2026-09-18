import { z } from "zod";
import { renderKnowledgeContext } from "@/lib/knowledge/retrieval";
import { getRun, listRuns } from "@/lib/repo/runs";
import { getTask, listTasks } from "@/lib/repo/tasks";
import { listComments } from "@/lib/repo/comments";
import { addFocusDirective } from "@/lib/settings/service";
import { NODE_STATUSES, NODE_TYPES, EVIDENCE_TYPES, SOURCE_TYPES } from "@/lib/types";
import { draftPost } from "@/lib/workflows/knowledge-ops";
import { ingestCommentTask, startDiscovery, startResearch } from "@/lib/workflows/tasks";
import type { RunContext } from "@/lib/workflows/types";
import { defineTool, type AnyAgentTool, type ToolResult } from "./types";

/**
 * Tools available to the chat agent. Every tool goes through the Knowledge
 * API / task entry points; none touch the database directly.
 */

const ok = <T>(data: T) => ({ ok: true as const, data });
const fail = (error: string) => ({ ok: false as const, error });

export function createChatTools(ctx: RunContext): AnyAgentTool[] {
  const k = ctx.deps.knowledge;

  return [
    defineTool({
      name: "search_knowledge",
      description:
        "Hybrid search over LENS's stored knowledge (claims, observations, hypotheses, insights, questions) with evidence counts and source excerpts. Use before answering any question about findings.",
      schema: z.object({
        query: z.string().min(2),
        types: z.array(z.enum(NODE_TYPES)).optional(),
        statuses: z.array(z.enum(NODE_STATUSES)).optional(),
        evidenceTypes: z.array(z.enum(EVIDENCE_TYPES)).optional(),
        sourceTypes: z.array(z.enum(SOURCE_TYPES)).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        limit: z.number().int().min(1).max(15).optional(),
      }),
      async execute({ query, ...filters }) {
        const result = await k.searchKnowledge(query, filters);
        return ok(renderKnowledgeContext(result, { maxChars: 8000 }));
      },
    }),
    defineTool({
      name: "get_claim",
      description:
        "Full detail for one knowledge node: supporting and contradicting evidence with verbatim quotes and sources, related nodes, open questions, confidence history.",
      schema: z.object({ id: z.uuid() }),
      async execute({ id }) {
        const d = await k.getClaim(id);
        if (!d) return fail(`No knowledge node ${id}`);
        const ev = (list: typeof d.supporting) =>
          list.map((e) => ({
            type: e.evidenceType,
            strength: e.strength,
            independence: e.independence,
            quote: e.quote,
            source: { id: e.source.id, title: e.source.title, url: e.source.url, date: e.source.publicationDate },
          }));
        return ok({
          node: d.node,
          supporting: ev(d.supporting),
          contradicting: ev(d.contradicting),
          contextual: ev(d.contextual),
          related: d.related.map((r) => ({ relationship: r.edge.relationshipType, direction: r.direction, node: { id: r.node.id, type: r.node.type, statement: r.node.statement } })),
          questions: d.questions.map((q) => ({ id: q.id, statement: q.statement, status: q.status })),
          history: d.history.map((h) => ({ at: h.createdAt, confidence: h.confidence, status: h.status, reason: h.reason })),
        });
      },
    }),
    defineTool({
      name: "list_knowledge",
      description: "List knowledge nodes by structured filters (e.g. all open questions, all contested claims, recent insights).",
      schema: z.object({
        types: z.array(z.enum(NODE_TYPES)).optional(),
        statuses: z.array(z.enum(NODE_STATUSES)).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      async execute(filters) {
        const nodes = await k.listNodes({ ...filters, limit: filters.limit ?? 15 });
        return ok(nodes.map((n) => ({ id: n.id, type: n.type, status: n.status, confidence: n.confidence, origin: n.origin, statement: n.statement })));
      },
    }),
    defineTool({
      name: "get_source",
      description: "Metadata and an excerpt of a stored source document.",
      schema: z.object({ id: z.uuid() }),
      async execute({ id }) {
        const s = await k.getSource(id);
        if (!s) return fail(`No source ${id}`);
        const { fullText, ...meta } = s;
        return ok({ ...meta, excerpt: (fullText ?? "").slice(0, 3000) });
      },
    }),
    defineTool({
      name: "search_literature",
      description:
        "Search external literature sources (read-only preview; nothing is stored). Use start_research to actually read and store sources.",
      schema: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(10).optional() }),
      async execute({ query, limit }) {
        const sources = ctx.deps.getResearchSources(ctx.settings.project.enabledSources);
        const results = [];
        for (const s of sources) {
          try {
            const rs = await s.search({ query, limit: limit ?? 5 });
            results.push(...rs.map((r) => ({ source: s.id, title: r.title, doi: r.doi, url: r.url, date: r.publicationDate, type: r.sourceType })));
          } catch (err) {
            results.push({ source: s.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return ok(results);
      },
    }),
    defineTool({
      name: "search_openlabs",
      description:
        "Search the community platform (OpenLabs) for posts, discussions and projects near a topic. Read-only preview; " +
        "nothing is stored. These are community posts, not peer-reviewed sources — never treat them as evidence. " +
        "Use start_discovery to triage results into open research questions.",
      schema: z.object({
        query: z.string().min(2),
        kinds: z.array(z.enum(["post", "project"])).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      async execute({ query, kinds, limit }) {
        const source = ctx.deps.getDiscoverySource();
        if (!source) return fail("No community platform is configured (set OPENLABS_AGENT_CREDENTIAL).");
        const items = await source.search({ query, kinds, limit: limit ?? 10 });
        return ok(
          items.map((i) => ({
            kind: i.kind,
            title: i.title,
            url: i.url,
            author: i.author,
            topic: i.topic,
            metrics: i.metrics,
            excerpt: i.excerpt.slice(0, 300),
          })),
        );
      },
    }),
    defineTool({
      name: "start_discovery",
      description:
        "Queue a background discovery task: search the community platform, triage what it finds against our research " +
        "question, and record genuinely new gaps as open questions. Records questions only — never claims or evidence.",
      schema: z.object({
        queries: z.array(z.string().min(2)).min(1).max(4),
        topic: z.string().optional(),
      }),
      async execute({ queries, topic }) {
        const task = await startDiscovery(ctx.deps, { queries, topic, origin: "chat" });
        return ok({ taskId: task.id, status: task.status, note: "Running in background; see the Runs page." });
      },
    }),
    defineTool({
      name: "start_research",
      description:
        "Queue and start a background research task (search → read → extract → store knowledge → maybe draft a post). Optionally give specific URLs (papers/pages) to read.",
      schema: z.object({
        objective: z.string().min(5),
        urls: z.array(z.url()).max(5).optional(),
      }),
      async execute({ objective, urls }) {
        const task = await startResearch(ctx.deps, { objective, urls, origin: "chat" });
        return ok({ taskId: task.id, status: task.status, note: "Running in background; see the Runs page." });
      },
    }),
    defineTool({
      name: "draft_post",
      description:
        "Write a draft research-update post from stored knowledge on a topic. The draft goes to the human approval queue; it is never published automatically.",
      schema: z.object({
        topic: z.string().min(5),
        angle: z.string().optional(),
        focusNodeIds: z.array(z.uuid()).max(6).optional(),
      }),
      async execute(input) {
        const post = await draftPost(ctx, { ...input, rationale: "Requested by operator via chat." });
        return ok({ postId: post.id, title: post.title, status: post.status });
      },
    }),
    defineTool({
      name: "respond_to_comment",
      description: "Start the reply workflow for an existing, unprocessed comment (drafts a reply into the approval queue).",
      schema: z.object({ commentId: z.uuid() }),
      async execute({ commentId }) {
        const task = await ingestCommentTask(ctx.deps, commentId, {});
        return ok({ taskId: task.id });
      },
    }),
    defineTool({
      name: "list_unprocessed_comments",
      description: "List comments on published posts that have not been handled yet.",
      schema: z.object({}),
      async execute() {
        const comments = await listComments({ unprocessedOnly: true, limit: 20 });
        return ok(comments.map((c) => ({ id: c.id, postId: c.postId, author: c.author, body: c.body.slice(0, 300) })));
      },
    }),
    defineTool({
      name: "record_question",
      description: "Record an open research question on the operator's behalf, optionally linked to the nodes that raise it.",
      schema: z.object({ statement: z.string().min(10), raisedBy: z.array(z.uuid()).max(5).optional() }),
      async execute({ statement, raisedBy }) {
        const { node, created } = await k.createQuestion({ statement, raisedBy, origin: "operator", runId: ctx.runId });
        return ok({ id: node.id, created });
      },
    }),
    defineTool({
      name: "add_focus_directive",
      description:
        "Persistently steer future research planning, e.g. 'Deprioritise epigenetic clocks; investigate functional outcomes'.",
      schema: z.object({ directive: z.string().min(5).max(300) }),
      async execute({ directive }) {
        const project = await addFocusDirective(directive);
        return ok({ focusDirectives: project.focusDirectives });
      },
    }),
    defineTool({
      name: "list_runs",
      description: "Recent agent runs (workflow, status, timing, errors).",
      schema: z.object({ limit: z.number().int().min(1).max(20).optional(), workflow: z.string().optional() }),
      async execute({ limit, workflow }) {
        const runs = await listRuns({ limit: limit ?? 10, workflow });
        return ok(
          runs.map((r) => ({
            id: r.id,
            workflow: r.workflow,
            status: r.status,
            taskId: r.taskId,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            error: r.error,
            steps: r.steps.map((s) => `${s.name}: ${s.status}${s.summary ? ` — ${s.summary}` : ""}`),
          })),
        );
      },
    }),
    defineTool({
      name: "get_run",
      description: "Detailed log of one agent run: steps, tool calls, LLM calls, output, errors.",
      schema: z.object({ id: z.uuid() }),
      async execute({ id }) {
        const run = await getRun(id);
        if (!run) return fail(`No run ${id}`);
        return ok({ ...run, toolCalls: run.toolCalls.slice(-30) });
      },
    }),
    defineTool({
      name: "get_task",
      description: "Status and output of a task; omit id to list recent tasks.",
      schema: z.object({ id: z.uuid().optional() }),
      async execute({ id }): Promise<ToolResult> {
        if (!id) {
          const tasks = await listTasks({ limit: 10 });
          return ok(tasks.map((t) => ({ id: t.id, type: t.type, status: t.status, objective: t.objective, createdAt: t.createdAt })));
        }
        const task = await getTask(id);
        if (!task) return fail(`No task ${id}`);
        const { state: _state, ...rest } = task;
        return ok(rest);
      },
    }),
  ];
}
