import { z } from "zod";
import type { DiscoveredItem } from "@/lib/integrations/types";
import type { Task } from "@/lib/types";
import { researchSystemPrompt } from "./prompts";
import type { BaseState, RunContext, WorkflowDefinition } from "./types";

/**
 * Loop 3: discovery.
 *
 * Searches a community platform for posts, discussions and projects near our
 * research question, triages what comes back, and records the genuinely new
 * gaps as open questions the operator can queue for drill-down.
 *
 * The hard rule here is the project's provenance guardrail: community writing
 * is NOT evidence. Nothing this workflow touches creates a claim, an
 * observation or an evidence row, and discovered items are deliberately not
 * stored as `sources` — so nothing can later be attached to them as evidence.
 * Provenance lives in each question's metadata instead.
 */

export interface DiscoverState extends BaseState {
  queries: string[];
  topic?: string;
  found?: DiscoveredItem[];
  triaged?: Triage["items"];
  questionIds?: string[];
  skipped?: { title: string; reason: string }[];
}

const triageSchema = z.object({
  items: z
    .array(
      z.object({
        index: z.number().int().describe("Index into the numbered list of discovered items."),
        relevant: z.boolean().describe("Whether this bears on our research question at all."),
        reason: z.string().describe("One sentence: why it is or is not relevant."),
        question: z
          .string()
          .nullable()
          .describe(
            "An open research question this raises for US, or null. Must be answerable from literature, " +
              "not from the post itself. Null if it only restates something we already track.",
          ),
      }),
    )
    .describe("Exactly one entry per discovered item, in the order given."),
});
type Triage = z.infer<typeof triageSchema>;

async function search(state: DiscoverState, ctx: RunContext): Promise<Partial<DiscoverState>> {
  const source = ctx.deps.getDiscoverySource();
  if (!source) {
    return { halted: "No community platform is configured, so there is nothing to discover." };
  }

  const { limits } = ctx.settings;
  const seen = new Map<string, DiscoveredItem>();

  for (const query of state.queries.slice(0, limits.maxQueriesPerRun)) {
    const items = await ctx.trace(
      `discovery_search:${source.id}`,
      { query, topic: state.topic },
      () => source.search({ query, topic: state.topic, limit: limits.maxDiscoveryResults }),
      (found) => ({ count: found.length, titles: found.slice(0, 5).map((f) => f.title) }),
    );
    // The same post can surface for several queries; keep one copy.
    for (const item of items) seen.set(`${item.kind}:${item.externalId}`, item);
  }

  const found = [...seen.values()].slice(0, limits.maxDiscoveryResults);
  if (found.length === 0) return { found: [], halted: "Nothing matched on the platform." };
  return { found };
}

function renderItem(item: DiscoveredItem, index: number): string {
  const metrics = [
    item.metrics.comments != null ? `${item.metrics.comments} comments` : null,
    item.metrics.upvotes != null ? `${item.metrics.upvotes} upvotes` : null,
    item.metrics.threads != null ? `${item.metrics.threads} threads` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return [
    `[${index}] (${item.kind}) ${item.title}`,
    item.author ? `by ${item.author}` : null,
    metrics || null,
    item.excerpt ? `excerpt: ${item.excerpt.slice(0, 600)}` : null,
  ]
    .filter(Boolean)
    .join("\n  ");
}

async function triage(state: DiscoverState, ctx: RunContext): Promise<Partial<DiscoverState>> {
  const found = state.found ?? [];
  if (found.length === 0) return { triaged: [] };

  // What we already track, so the model can tell "new gap" from "already known".
  const existing = await ctx.trace(
    "list_open_questions",
    {},
    () => ctx.deps.knowledge.listNodes({ types: ["question"], statuses: ["open"], limit: 30 }),
    (nodes) => ({ count: nodes.length }),
    { bookkeeping: true },
  );

  const { data } = await ctx.llm.structured(
    "research_planner",
    "discovery_triage",
    {
      system: researchSystemPrompt(ctx.settings),
      messages: [
        {
          role: "user",
          content: `Community members have posted the following on a research platform. Decide which bear on our research question, and what genuinely NEW open questions they raise for us.

Rules:
- These are community posts, NOT peer-reviewed sources. Nothing here is evidence. Treat a post's claims as things to INVESTIGATE, never as things established.
- A question must be answerable from the literature, not by reading the post.
- Return null for "question" if the item is off-topic, or only restates something in OUR OPEN QUESTIONS below.
- Prefer questions that would change what we do next: safety/efficacy trade-offs, replication gaps, mechanisms we do not track.
- Return exactly one entry per item, with its index.

OUR RESEARCH QUESTION: ${ctx.settings.project.researchQuestion}

OUR OPEN QUESTIONS (do not duplicate these):
${existing.map((q) => `- ${q.statement}`).join("\n") || "(none)"}

DISCOVERED ITEMS:
${found.map((item, i) => renderItem(item, i)).join("\n\n")}`,
        },
      ],
      maxTokens: 4000,
    },
    { name: "discovery_triage", schema: triageSchema },
  );

  // Drop entries pointing at indices the model invented.
  const items = data.items.filter((i) => i.index >= 0 && i.index < found.length);
  return { triaged: items };
}

async function record(state: DiscoverState, ctx: RunContext): Promise<Partial<DiscoverState>> {
  const found = state.found ?? [];
  const questionIds: string[] = [];
  const skipped: { title: string; reason: string }[] = [];
  const limit = ctx.settings.limits.maxQuestionsPerDiscovery;

  for (const entry of state.triaged ?? []) {
    const item = found[entry.index];
    if (!item) continue;
    if (!entry.relevant || !entry.question) {
      skipped.push({ title: item.title, reason: entry.reason });
      continue;
    }
    if (questionIds.length >= limit) {
      skipped.push({ title: item.title, reason: `Over the per-run question limit (${limit}).` });
      continue;
    }

    const { node, created } = await ctx.trace(
      "create_question",
      { statement: entry.question, from: item.externalId },
      () =>
        ctx.deps.knowledge.createQuestion({
          statement: entry.question!,
          origin: "agent_generated",
          tags: item.tags.slice(0, 4),
          // Provenance without a `sources` row: the item can be traced and
          // opened, but can never be attached to a claim as evidence.
          metadata: {
            discoveredFrom: {
              source: item.sourceId,
              kind: item.kind,
              externalId: item.externalId,
              title: item.title,
              url: item.url,
              author: item.author,
            },
            triageReason: entry.reason,
          },
          runId: ctx.runId,
        }),
      (r) => ({ id: r.node.id, created: r.created }),
      { bookkeeping: true },
    );
    if (created) questionIds.push(node.id);
    else skipped.push({ title: item.title, reason: "Already tracked (deduplicated against an existing question)." });
  }

  return { questionIds, skipped };
}

export const discoverWorkflow: WorkflowDefinition<DiscoverState> = {
  name: "discover",
  primaryModel: "research_planner",
  initialState: (task: Task) => ({
    queries: (task.input.queries as string[] | undefined) ?? [task.objective],
    topic: task.input.topic as string | undefined,
  }),
  steps: [
    { name: "search", run: search, summarize: (s) => `${s.found?.length ?? 0} items found` },
    {
      name: "triage",
      run: triage,
      summarize: (s) => `${(s.triaged ?? []).filter((t) => t.relevant).length} relevant of ${s.triaged?.length ?? 0}`,
    },
    {
      name: "record",
      run: record,
      summarize: (s) => `${s.questionIds?.length ?? 0} new questions, ${s.skipped?.length ?? 0} skipped`,
    },
  ],
  finalStatus: () => "completed",
  output: (s) => ({
    found: s.found?.map((f) => ({ kind: f.kind, title: f.title, url: f.url })) ?? [],
    questionIds: s.questionIds ?? [],
    skipped: s.skipped ?? [],
    halted: s.halted ?? null,
  }),
};
