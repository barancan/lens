import { describe, expect, it } from "vitest";
import { listPosts } from "@/lib/repo/posts";
import { getRun } from "@/lib/repo/runs";
import { createTask, getTask } from "@/lib/repo/tasks";
import { DEFAULT_SETTINGS } from "@/lib/settings/schema";
import { updateSettings } from "@/lib/settings/service";
import type { LLMRequest } from "@/lib/llm/types";
import { runTask } from "@/lib/workflows/tasks";
import { idsIn, makeDeps, ScriptedProvider } from "../helpers/agent";
import { useTestDb } from "../helpers/db";

const GOOD_QUOTE = "No teratomas were detected in any treated animal during the observation period.";
const CLAIM = "Cyclic OSK induction in aged mice did not produce teratomas during the observation period.";

type Handler = (req: LLMRequest, prompt: string) => unknown;

function extraction(quote: string) {
  return {
    relevant: true,
    relevanceNote: "in vivo safety",
    studyContext: { organism: "mouse", system: null, intervention: "cyclic OSK", design: "in vivo", sampleSize: null },
    findings: [{ kind: "claim", statement: CLAIM, quote, strength: "moderate", tags: ["teratoma", "osk"] }],
    openQuestions: ["Does cyclic OSK remain safe over a full lifespan?"],
  };
}

const synthesis: Handler = (_req, prompt) => {
  const touched = idsIn(prompt.split("WIDER STORED KNOWLEDGE")[0]);
  return {
    summary: "First safety evidence stored.",
    insights: [
      { statement: "Safety evidence so far is limited to one mouse study (interpretation).", derivedFrom: touched, confidence: 0.4 },
      { statement: "Insight citing an invented id must be dropped.", derivedFrom: ["00000000-0000-0000-0000-000000000000"], confidence: 0.5 },
    ],
    questions: [],
    postWorthy: true,
    postTopic: "Teratoma risk of cyclic OSK",
    postAngle: "what one mouse study does and does not show",
    postRationale: "First direct safety evidence.",
    postType: "discussion",
    focusNodeIds: touched,
  };
};

function researchScript(overrides: Record<string, Handler> = {}) {
  return new ScriptedProvider({
    research_plan: () => ({ rationale: "safety first", subQuestions: ["Is cyclic OSK tumorigenic?"], queries: ["teratoma"] }),
    source_selection: () => ({ selected: [{ index: 0, reason: "primary in vivo safety data" }] }),
    source_extraction: () => extraction(GOOD_QUOTE),
    knowledge_decisions: () => ({
      decisions: [{ index: 0, action: "create", targetId: null, evidenceType: "supports", rationale: "new" }],
    }),
    research_synthesis: synthesis,
    post_draft: () => ({
      title: "Early safety signal for cyclic OSK",
      body: "One mouse study reports no teratomas with cyclic OSK [1]. A fabricated citation [7] must be removed.",
      rationale: "Informative but preliminary.",
    }),
    ...overrides,
  });
}

describe("research workflow", () => {
  useTestDb();

  it("runs plan → draft, storing knowledge with provenance and queuing a post for approval", async () => {
    const provider = researchScript();
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "Assess teratoma risk of cyclic OSK", origin: "user" });

    const outcome = await runTask(task.id, deps);
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe("awaiting_approval");

    const claims = await deps.knowledge.listNodes({ types: ["claim"] });
    expect(claims).toHaveLength(1);
    expect(claims[0].origin).toBe("source_derived");
    const detail = await deps.knowledge.getClaim(claims[0].id);
    expect(detail?.supporting).toHaveLength(1);
    expect(detail?.supporting[0].quote).toBe(GOOD_QUOTE);
    expect(detail?.supporting[0].source.doi).toBe("10.1000/osk.1");

    const insights = await deps.knowledge.listNodes({ types: ["insight"] });
    expect(insights).toHaveLength(1);
    expect(insights[0].origin).toBe("agent_generated");
    const questions = await deps.knowledge.listNodes({ types: ["question"] });
    expect(questions.map((q) => q.statement)).toContain("Does cyclic OSK remain safe over a full lifespan?");

    const [post] = await listPosts();
    expect(post.status).toBe("awaiting_review");
    expect(post.body).toContain("[1]");
    expect(post.body).not.toContain("[7]");
    expect(post.body).toContain("**Sources**");
    expect(post.metadata.sourceIds).toHaveLength(1);
    expect(post.metadata.model).toBeTruthy();
    expect(post.metadata.rationale).toContain("First direct safety evidence");

    const run = await getRun(outcome.runId!);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.map((s) => s.name)).toEqual([
      "plan", "search", "select", "read", "extract", "compare", "store", "synthesize", "assess_impact", "draft",
    ]);
    expect(run?.llmCalls.length).toBeGreaterThanOrEqual(6);
    expect(run?.usage.inputTokens).toBeGreaterThan(0);
    expect(run?.toolCalls.some((c) => c.tool === "research_search:mock")).toBe(true);
  });

  it("rejects findings whose quote is not verbatim in the source", async () => {
    const provider = researchScript({ source_extraction: () => extraction("OSK completely reverses aging in humans.") });
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "x", origin: "user" });

    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("completed");
    expect(await deps.knowledge.listNodes({ types: ["claim"] })).toHaveLength(0);
    const done = await getTask(task.id);
    expect(done?.output?.rejectedFindings).toHaveLength(1);
    expect(done?.output?.halted).toBe("no new knowledge stored");
    expect(await listPosts()).toHaveLength(0);
  });

  it("halts cleanly when no new sources are found", async () => {
    const provider = researchScript({
      research_plan: () => ({ rationale: "r", subQuestions: ["q"], queries: ["nothing matches this"] }),
    });
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "x", origin: "user" });
    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("completed");
    expect((await getTask(task.id))?.output?.halted).toBe("no new sources found");
    expect(provider.calls("source_selection")).toHaveLength(0);
  });

  it("fails without losing progress and resumes from the checkpoint", async () => {
    let failSynthesis = true;
    const provider = researchScript({
      research_synthesis: (req, prompt) => {
        if (failSynthesis) throw new Error("provider overloaded");
        return synthesis(req, prompt);
      },
    });
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "x", origin: "user" });

    const first = await runTask(task.id, deps);
    expect(first.status).toBe("failed");
    expect(first.error).toContain("provider overloaded");
    const failed = await getTask(task.id);
    expect((failed?.state as { completedSteps: string[] }).completedSteps).toContain("store");
    expect((await getRun(first.runId!))?.status).toBe("failed");

    // A plain run does not pick up a failed task; resume does.
    expect((await runTask(task.id, deps)).status).toBe("cancelled");
    failSynthesis = false;
    const second = await runTask(task.id, deps, { resume: true });
    expect(second.status).toBe("awaiting_approval");
    expect(provider.calls("research_plan")).toHaveLength(1);
    expect(provider.calls("source_extraction")).toHaveLength(1);
    expect(await deps.knowledge.listNodes({ types: ["claim"] })).toHaveLength(1);
    const run2 = await getRun(second.runId!);
    expect(run2?.steps.map((s) => s.name)).toEqual(["synthesize", "assess_impact", "draft"]);
  });

  it("counts only external calls against the tool-call budget", async () => {
    const { deps } = makeDeps(researchScript());
    const task = await createTask({ type: "research", objective: "x", origin: "user" });

    // One search and one fetch are external; knowledge-store reads and writes are not budgeted.
    await updateSettings("limits", { ...DEFAULT_SETTINGS.limits, maxToolCalls: 2 });
    const ok = await runTask(task.id, deps);
    expect(ok.error).toBeUndefined();
    expect(ok.status).toBe("awaiting_approval");
    const run = await getRun(ok.runId!);
    expect(run!.toolCalls.length).toBeGreaterThan(2);
  });

  it("fails with an actionable error when the tool-call budget runs out", async () => {
    const { deps } = makeDeps(researchScript());
    const task = await createTask({ type: "research", objective: "x", origin: "user" });
    await updateSettings("limits", { ...DEFAULT_SETTINGS.limits, maxToolCalls: 1 });
    const limited = await runTask(task.id, deps);
    expect(limited.status).toBe("failed");
    expect(limited.error).toMatch(/^Step "read" failed: Tool call limit reached \(1\)/);
  });

  it("reads operator-provided URLs even without search results", async () => {
    const provider = researchScript({
      research_plan: () => ({ rationale: "r", subQuestions: ["q"], queries: ["nothing matches this"] }),
    });
    const { deps } = makeDeps(provider);
    const task = await createTask({
      type: "research",
      objective: "read this page",
      origin: "chat",
      input: { urls: ["https://example.com/page"] },
    });
    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("awaiting_approval");
    const sources = await deps.knowledge.listSources({});
    expect(sources.map((s) => s.url)).toContain("https://example.com/page");
    expect(provider.calls("source_selection")).toHaveLength(0);
  });

  function promptTextOf(req: LLMRequest): string {
    return req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  }

  it("suggests a claim and asks the post writer for a falsification test when the synthesis marks it as one", async () => {
    const provider = researchScript({
      research_synthesis: (req, prompt) => ({ ...(synthesis(req, prompt) as Record<string, unknown>), postType: "claim" }),
    });
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "x", origin: "user" });

    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("awaiting_approval");

    const [post] = await listPosts();
    expect(post.metadata.openlabs).toEqual({ type: "claim" });

    const draftCall = provider.calls("post_draft").at(-1);
    expect(draftCall).toBeDefined();
    const promptText = promptTextOf(draftCall!);
    expect(promptText).toMatch(/falsification/i);
    expect(promptText.toUpperCase()).toContain("CLAIM");
  });

  // Regression: the model marked a post but omitted every other post field (the
  // schema used to require them all, failing the step and losing the synthesis).
  const NRF2_TOPIC = "Oxidative stress and NRF2 signalling during in-vivo partial reprogramming";
  const NRF2_QUESTION = "Is the NRF2 response separable from identity loss?";
  const postlessSynthesis = (post: Record<string, unknown>): Handler => (_req, prompt) => {
    const touched = idsIn(prompt.split("WIDER STORED KNOWLEDGE")[0]);
    return {
      summary: "A long, high-quality paragraph about what changed.",
      insights: [{ statement: "NRF2 induction may be a separate axis (interpretation).", derivedFrom: touched, confidence: 0.3 }],
      questions: [{ statement: NRF2_QUESTION, raisedBy: touched }],
      ...post,
    };
  };

  it("keeps the synthesis when postWorthy is true but the other post fields are missing, drafting with defaults", async () => {
    const provider = researchScript({ research_synthesis: postlessSynthesis({ postWorthy: true, postTopic: NRF2_TOPIC }) });
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "Assess teratoma risk of cyclic OSK", origin: "user" });

    const outcome = await runTask(task.id, deps);
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe("awaiting_approval");
    expect((await getRun(outcome.runId!))?.status).toBe("succeeded");

    const insights = await deps.knowledge.listNodes({ types: ["insight"] });
    expect(insights).toHaveLength(1);
    const questions = await deps.knowledge.listNodes({ types: ["question"] });
    expect(questions.map((q) => q.statement)).toContain(NRF2_QUESTION);

    // Post type falls back to the OpenLabs default; focus falls back to the nodes this run touched.
    const [post] = await listPosts();
    expect(post.status).toBe("awaiting_review");
    expect(post.metadata.topic).toBe(NRF2_TOPIC);
    expect(post.metadata.openlabs).toEqual({ type: DEFAULT_SETTINGS.openlabs.defaultPostType });
    const [claim] = await deps.knowledge.listNodes({ types: ["claim"] });
    expect(post.metadata.nodeIds).toContain(claim.id);
    expect(post.metadata.rationale).toContain("Research objective: Assess teratoma risk of cyclic OSK");
    expect(promptTextOf(provider.calls("post_draft").at(-1)!)).not.toMatch(/falsification/i);
  });

  it("falls back to the objective as the post topic when postWorthy is true but no topic is given", async () => {
    const provider = researchScript({ research_synthesis: postlessSynthesis({ postWorthy: true }) });
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "Assess teratoma risk of cyclic OSK", origin: "user" });

    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("awaiting_approval");
    const [post] = await listPosts();
    expect(post.metadata.topic).toBe("Assess teratoma risk of cyclic OSK");
  });

  it("completes without a post when the synthesis is not post-worthy, keeping insights and questions", async () => {
    const provider = researchScript({ research_synthesis: postlessSynthesis({ postWorthy: false }) });
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "x", origin: "user" });

    const outcome = await runTask(task.id, deps);
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe("completed");
    expect(await deps.knowledge.listNodes({ types: ["insight"] })).toHaveLength(1);
    expect((await deps.knowledge.listNodes({ types: ["question"] })).map((q) => q.statement)).toContain(NRF2_QUESTION);
    expect(await listPosts()).toHaveLength(0);
    expect(provider.calls("post_draft")).toHaveLength(0);
    const run = await getRun(outcome.runId!);
    expect(run?.steps.map((s) => s.name)).toContain("draft");
    expect((await getTask(task.id))?.output?.summary).toBe("A long, high-quality paragraph about what changed.");
  });

  it("defaults to discussion when the synthesis does not mark a claim, leaving the post-writer prompt unchanged", async () => {
    const provider = researchScript();
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "x", origin: "user" });

    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("awaiting_approval");

    const [post] = await listPosts();
    expect(post.metadata.openlabs).toEqual({ type: "discussion" });

    const draftCall = provider.calls("post_draft").at(-1);
    expect(draftCall).toBeDefined();
    expect(promptTextOf(draftCall!)).not.toMatch(/falsification/i);
  });
});

describe("research workflow: operator drill-down", () => {
  useTestDb();

  it("puts a queued finding in front of the planner and marks it consumed", async () => {
    const provider = researchScript();
    const { deps } = makeDeps(provider);

    const target = await deps.knowledge.createClaim({
      statement: "p53 attenuation during OSK induction raises teratoma risk.",
    });
    await deps.knowledge.requestDrillDown(target.node.id, "check the p53 angle specifically");

    const task = await createTask({ type: "research", objective: "Assess teratoma risk of cyclic OSK", origin: "user" });
    const outcome = await runTask(task.id, deps);
    expect(outcome.error).toBeUndefined();

    // The operator's request, and their note, reached the planner verbatim.
    const planPrompt = String(provider.calls("research_plan")[0].messages[0].content);
    expect(planPrompt).toContain("OPERATOR DRILL-DOWN REQUESTS");
    expect(planPrompt).toContain("p53 attenuation during OSK induction raises teratoma risk.");
    expect(planPrompt).toContain("operator note: check the p53 angle specifically");
    expect(planPrompt).toContain("MUST target the first operator drill-down request");

    // Consumed by the run that acted on it, and off the queue.
    expect(await deps.knowledge.listDrillDownQueue()).toHaveLength(0);
    const after = await deps.knowledge.getNode(target.node.id);
    expect(after!.drillDownConsumedAt).not.toBeNull();
    expect(after!.drillDownRequestedAt).not.toBeNull();

    const run = await getRun(outcome.runId!);
    expect(run?.output).toMatchObject({ drillDownNodeIds: [target.node.id] });
  });

  it("says nothing about drill-down when the queue is empty", async () => {
    const provider = researchScript();
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "Assess teratoma risk of cyclic OSK", origin: "user" });
    await runTask(task.id, deps);

    const planPrompt = String(provider.calls("research_plan")[0].messages[0].content);
    expect(planPrompt).not.toContain("OPERATOR DRILL-DOWN");
  });

  it("leaves the request queued when the run fails before storing anything", async () => {
    // Extraction fails, so `store` never runs and the request is not consumed.
    const provider = researchScript({
      source_extraction: () => {
        throw new Error("extraction exploded");
      },
    });
    const { deps } = makeDeps(provider);

    const target = await deps.knowledge.createClaim({ statement: "A claim the operator wants drilled." });
    await deps.knowledge.requestDrillDown(target.node.id, "still pending");

    const task = await createTask({ type: "research", objective: "Assess teratoma risk of cyclic OSK", origin: "user" });
    const outcome = await runTask(task.id, deps);
    expect(outcome.status).toBe("failed");

    // Still queued for the next cycle rather than silently lost.
    expect((await deps.knowledge.listDrillDownQueue()).map((n) => n.id)).toEqual([target.node.id]);
  });

  it("scores impact for the findings a run touched", async () => {
    const provider = researchScript();
    const { deps } = makeDeps(provider);
    const task = await createTask({ type: "research", objective: "Assess teratoma risk of cyclic OSK", origin: "user" });
    const outcome = await runTask(task.id, deps);

    const claims = await deps.knowledge.listNodes({ types: ["claim"] });
    expect(claims[0].impactComputedAt).not.toBeNull();
    expect(claims[0].impactExplanation!.reasons.length).toBeGreaterThan(0);

    const run = await getRun(outcome.runId!);
    expect((run?.output as { impactRecomputed: number }).impactRecomputed).toBeGreaterThan(0);
  });
});

describe("research workflow: drill-down ordering", () => {
  useTestDb();

  it("takes the operator's manual order, not the impact order", async () => {
    const provider = researchScript();
    const { deps } = makeDeps(provider);

    const first = await deps.knowledge.createClaim({ statement: "Queued first but demoted by the operator." });
    const second = await deps.knowledge.createClaim({ statement: "Queued second but dragged to the top." });
    await deps.knowledge.requestDrillDown(first.node.id);
    await deps.knowledge.requestDrillDown(second.node.id);
    await deps.knowledge.reorderDrillDownQueue([second.node.id, first.node.id]);

    // Only one target per run, so the ordering decides which is taken.
    await updateSettings("limits", { ...DEFAULT_SETTINGS.limits, maxDrillDownTargets: 1 });

    const task = await createTask({ type: "research", objective: "Assess teratoma risk of cyclic OSK", origin: "user" });
    await runTask(task.id, deps);

    // Scope the assertion to the drill-down block: an unresolved claim also
    // shows up further down under "CLAIMS NEEDING WORK", which is unrelated.
    const planPrompt = String(provider.calls("research_plan")[0].messages[0].content);
    const drillDownBlock = planPrompt.split("Knowledge base:")[0];
    expect(drillDownBlock).toContain("OPERATOR DRILL-DOWN REQUESTS");
    expect(drillDownBlock).toContain("Queued second but dragged to the top.");
    expect(drillDownBlock).not.toContain("Queued first but demoted by the operator.");

    // The demoted one stays queued for a later run.
    expect((await deps.knowledge.getNode(second.node.id))!.drillDownConsumedAt).not.toBeNull();
    expect((await deps.knowledge.listDrillDownQueue(10)).map((n) => n.id)).toEqual([first.node.id]);
  });
});
