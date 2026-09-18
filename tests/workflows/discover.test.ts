import { describe, expect, it } from "vitest";
import { getRun } from "@/lib/repo/runs";
import { createTask } from "@/lib/repo/tasks";
import { runTask } from "@/lib/workflows/tasks";
import { discoveredItem, makeDeps, MockDiscoverySource, ScriptedProvider } from "../helpers/agent";
import { useTestDb } from "../helpers/db";

const HYPOXIA = discoveredItem({
  externalId: "post-hypoxia",
  title: "Intermittent hypoxia as a safeguard during cyclic OSK reprogramming",
});
const OFF_TOPIC = discoveredItem({
  externalId: "post-offtopic",
  kind: "project",
  title: "A marketplace for lab equipment",
  excerpt: "Building a marketplace. Nothing to do with reprogramming.",
});

/** Triage handler that accepts the first item and rejects the second. */
function triageScript(question = "Does intermittent hypoxia during OSK cycles reduce teratoma incidence in aged mice?") {
  return new ScriptedProvider({
    discovery_triage: () => ({
      items: [
        { index: 0, relevant: true, reason: "Directly about OSK safety.", question },
        { index: 1, relevant: false, reason: "Unrelated to the research question.", question: null },
      ],
    }),
  });
}

async function runDiscovery(provider: ScriptedProvider, items = [HYPOXIA, OFF_TOPIC]) {
  const discovery = new MockDiscoverySource(items);
  const { deps } = makeDeps(provider, undefined, discovery);
  const task = await createTask({
    type: "discover",
    objective: "Discover community work on: partial reprogramming",
    origin: "user",
    input: { queries: ["partial reprogramming"] },
  });
  const outcome = await runTask(task.id, deps);
  return { outcome, deps, discovery };
}

describe("discover workflow", () => {
  useTestDb();

  it("searches, triages and records a new open question", async () => {
    const { outcome, deps, discovery } = await runDiscovery(triageScript());
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe("completed");

    expect(discovery.queries.map((q) => q.query)).toEqual(["partial reprogramming"]);

    const questions = await deps.knowledge.listNodes({ types: ["question"] });
    expect(questions).toHaveLength(1);
    expect(questions[0].statement).toContain("intermittent hypoxia");
    expect(questions[0].origin).toBe("agent_generated");
    expect(questions[0].status).toBe("open");

    const run = await getRun(outcome.runId!);
    expect(run?.status).toBe("succeeded");
    expect(run?.steps.map((s) => s.name)).toEqual(["search", "triage", "record"]);
  });

  it("keeps provenance on the question without creating a source", async () => {
    const { deps } = await runDiscovery(triageScript());

    const [question] = await deps.knowledge.listNodes({ types: ["question"] });
    expect(question.metadata.discoveredFrom).toMatchObject({
      source: "mock-community",
      kind: "post",
      externalId: "post-hypoxia",
      url: "https://example.org/post/post-1",
    });
  });

  it("NEVER turns community writing into evidence", async () => {
    // The guardrail that matters: a discovery run may only ever add questions.
    const { deps } = await runDiscovery(triageScript());

    for (const type of ["claim", "observation", "insight", "hypothesis"] as const) {
      expect(await deps.knowledge.listNodes({ types: [type] })).toHaveLength(0);
    }
    const stats = await deps.knowledge.stats();
    expect(stats.evidence).toBe(0);
    expect(stats.sources).toBe(0);
  });

  it("skips items the triage marks irrelevant, with a reason", async () => {
    const { outcome } = await runDiscovery(triageScript());
    const run = await getRun(outcome.runId!);
    const output = run?.output as { skipped: { title: string; reason: string }[]; questionIds: string[] };

    expect(output.questionIds).toHaveLength(1);
    expect(output.skipped).toHaveLength(1);
    expect(output.skipped[0].title).toContain("marketplace");
    expect(output.skipped[0].reason).toContain("Unrelated");
  });

  it("does not record a question that duplicates one we already track", async () => {
    const provider = triageScript();
    const discovery = new MockDiscoverySource([HYPOXIA, OFF_TOPIC]);
    const { deps } = makeDeps(provider, undefined, discovery);

    // Same statement already stored, so dedupe should catch it.
    const existing = await deps.knowledge.createQuestion({
      statement: "Does intermittent hypoxia during OSK cycles reduce teratoma incidence in aged mice?",
      origin: "operator",
    });

    const task = await createTask({
      type: "discover",
      objective: "Discover",
      origin: "user",
      input: { queries: ["partial reprogramming"] },
    });
    const outcome = await runTask(task.id, deps);

    const questions = await deps.knowledge.listNodes({ types: ["question"] });
    expect(questions.map((q) => q.id)).toEqual([existing.node.id]);

    const run = await getRun(outcome.runId!);
    const output = run?.output as { skipped: { reason: string }[] };
    expect(output.skipped.some((s) => /already tracked/i.test(s.reason))).toBe(true);
  });

  it("halts cleanly when no community platform is configured", async () => {
    const { deps } = makeDeps(triageScript(), undefined, null);
    const task = await createTask({ type: "discover", objective: "Discover", origin: "user", input: {} });

    const outcome = await runTask(task.id, deps);
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe("completed");

    const run = await getRun(outcome.runId!);
    expect((run?.output as { halted: string }).halted).toMatch(/no community platform/i);
    // Nothing was invented in place of real results.
    expect(await deps.knowledge.listNodes({ types: ["question"] })).toHaveLength(0);
  });

  it("halts when the platform returns nothing", async () => {
    const { outcome, deps } = await runDiscovery(triageScript(), []);
    expect(outcome.status).toBe("completed");
    expect(await deps.knowledge.listNodes({ types: ["question"] })).toHaveLength(0);

    const run = await getRun(outcome.runId!);
    expect((run?.output as { halted: string }).halted).toMatch(/nothing matched/i);
  });

  it("ignores a triage entry pointing at an item that does not exist", async () => {
    const provider = new ScriptedProvider({
      discovery_triage: () => ({
        items: [
          { index: 99, relevant: true, reason: "Invented index.", question: "A question from nowhere?" },
          { index: 0, relevant: true, reason: "Real one.", question: "Does hypoxia preconditioning change OSK safety?" },
        ],
      }),
    });
    const { deps } = await runDiscovery(provider);

    const questions = await deps.knowledge.listNodes({ types: ["question"] });
    expect(questions).toHaveLength(1);
    expect(questions[0].statement).toContain("hypoxia preconditioning");
  });

  it("caps how many questions one run may record", async () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      discoveredItem({ externalId: `post-${i}`, title: `Community post ${i}` }),
    );
    const provider = new ScriptedProvider({
      discovery_triage: () => ({
        items: items.map((_, i) => ({
          index: i,
          relevant: true,
          reason: "Relevant.",
          question: `Distinct question number ${i} about OSK reprogramming safety in aged tissue?`,
        })),
      }),
    });
    const { outcome, deps } = await runDiscovery(provider, items);

    // Default limits.maxQuestionsPerDiscovery is 5.
    expect(await deps.knowledge.listNodes({ types: ["question"], limit: 50 })).toHaveLength(5);
    const run = await getRun(outcome.runId!);
    expect((run?.output as { skipped: { reason: string }[] }).skipped.some((s) => /limit/i.test(s.reason))).toBe(true);
  });
});
