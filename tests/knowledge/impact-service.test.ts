import { describe, expect, it } from "vitest";
import { createKnowledgeService, DrillDownQueueFullError, MAX_DRILL_DOWN_QUEUE } from "@/lib/knowledge/service";
import { fakeEmbedding, useTestDb } from "../helpers/db";

describe("impact recompute", () => {
  const t = useTestDb();
  const svc = createKnowledgeService({ embed: async (texts: string[]) => texts.map((text) => fakeEmbedding(text)) });

  /** A contested claim contradicted by another, plus a question it raised. */
  async function buildGraph() {
    const a = await svc.createClaim({ statement: "OSK reprogramming reduces epigenetic age in mouse retina." });
    const b = await svc.createClaim({ statement: "OSK reprogramming does not reduce epigenetic age in mouse retina." });
    await svc.linkKnowledge({
      fromId: b.node.id,
      toId: a.node.id,
      relationshipType: "contradicts",
      sourceId: null,
      metadata: {},
    });
    const q = await svc.createQuestion({
      statement: "Does OSK dosing duration change the epigenetic age effect?",
      raisedBy: [a.node.id],
      origin: "agent_generated",
    });
    return { a: a.node, b: b.node, q: q.node };
  }

  it("scores a node from its neighbourhood and stores the breakdown", async () => {
    const { a } = await buildGraph();
    const updated = await svc.recomputeImpact([a.id]);
    expect(updated).toBe(1);

    const node = await svc.getNode(a.id);
    expect(node!.impact).not.toBeNull();
    expect(node!.impact!).toBeGreaterThan(0);
    expect(node!.impactComputedAt).not.toBeNull();

    // The jsonb round-trip must preserve the whole explanation.
    const explanation = node!.impactExplanation!;
    expect(explanation.reasons.length).toBeGreaterThan(0);
    expect(explanation.components.headroom).toBeGreaterThan(0);
    expect(explanation.components.edgeNeighbours).toBeGreaterThanOrEqual(2);
    expect(node!.impact).toBeCloseTo(
      Math.round(explanation.components.headroom * explanation.components.reach * 1000) / 1000,
      3,
    );
  });

  it("does NOT bump updated_at — impact churn must not pollute the Updated column", async () => {
    const { a } = await buildGraph();
    const before = (await svc.getNode(a.id))!.updatedAt;
    await svc.recomputeImpact([a.id]);
    expect((await svc.getNode(a.id))!.updatedAt).toBe(before);
  });

  it("does NOT write knowledge_node_history — that trail is confidence/status only", async () => {
    const { a } = await buildGraph();
    const before = (await svc.getClaim(a.id))!.history.length;
    await svc.recomputeImpact([a.id], { includeNeighbours: true });
    expect((await svc.getClaim(a.id))!.history).toHaveLength(before);
  });

  it("recomputes the 1-hop neighbourhood when asked", async () => {
    const { a, b, q } = await buildGraph();
    await svc.recomputeImpact([a.id], { includeNeighbours: true });
    for (const id of [a.id, b.id, q.id]) {
      expect((await svc.getNode(id))!.impactComputedAt).not.toBeNull();
    }
  });

  it("writes many nodes in one batch", async () => {
    const { a, b, q } = await buildGraph();
    expect(await svc.recomputeImpact([a.id, b.id, q.id])).toBe(3);
  });

  it("scores a node with no embedding without throwing, and says why", async () => {
    // Mimics a seeded question: inserted before Backfill embeddings has run.
    const [row] = await t.sql<{ id: string }[]>`
      insert into knowledge_nodes (type, statement, origin, status)
      values ('question', 'A seeded theme with no embedding yet.', 'operator', 'open')
      returning id`;
    expect(await svc.recomputeImpact([row.id])).toBe(1);

    const node = await svc.getNode(row.id);
    expect(node!.impact).toBeNull();
    expect(node!.impactExplanation!.reasons.join(" ")).toMatch(/backfill embeddings/i);
  });

  it("ranks a contested, well-connected claim above an isolated one", async () => {
    const { a } = await buildGraph();
    const lonely = await svc.createClaim({ statement: "An unrelated aside about telomerase assays." });
    await svc.recomputeImpact([a.id, lonely.node.id]);

    const ranked = await svc.listNodes({ types: ["claim"], orderBy: "impact", limit: 10 });
    expect(ranked[0].id).toBe(a.id);
    expect((await svc.getNode(a.id))!.impact!).toBeGreaterThan((await svc.getNode(lonely.node.id))!.impact!);
  });

  it("names the neighbours that would move on the detail view", async () => {
    const { a, b, q } = await buildGraph();
    await svc.recomputeImpact([a.id]);

    const detail = await svc.getClaim(a.id);
    const ids = detail!.impactNeighbours.map((n) => n.node.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(q.id);
    // Sorted by how much each stands to gain, strongest first.
    const gains = detail!.impactNeighbours.map((n) => n.gain);
    expect([...gains].sort((x, y) => y - x)).toEqual(gains);
    expect(detail!.impactNeighbours.find((n) => n.node.id === b.id)!.link).toMatchObject({
      kind: "edge",
      relationshipType: "contradicts",
    });
  });

  it("refreshes the stalest nodes first", async () => {
    const { a } = await buildGraph();
    expect(await svc.recomputeAllImpact(100)).toBeGreaterThanOrEqual(3);
    expect((await svc.getNode(a.id))!.impactComputedAt).not.toBeNull();
  });
});

describe("drill-down queue", () => {
  useTestDb();
  const svc = createKnowledgeService({ embed: async (texts: string[]) => texts.map((text) => fakeEmbedding(text)) });

  it("queues, lists, consumes and keeps the record", async () => {
    const { node } = await svc.createClaim({ statement: "A claim worth drilling into." });

    await svc.requestDrillDown(node.id, "  check the p53 angle  ");
    const queued = await svc.listDrillDownQueue();
    expect(queued.map((n) => n.id)).toEqual([node.id]);
    expect(queued[0].drillDownNote).toBe("check the p53 angle");

    await svc.markDrillDownConsumed([node.id]);
    expect(await svc.listDrillDownQueue()).toHaveLength(0);

    // Consumed, but the request itself is kept so the operator can still see it.
    const after = await svc.getNode(node.id);
    expect(after!.drillDownRequestedAt).not.toBeNull();
    expect(after!.drillDownConsumedAt).not.toBeNull();
    expect(after!.drillDownNote).toBe("check the p53 angle");
  });

  it("re-requesting a consumed node puts it back in the queue", async () => {
    const { node } = await svc.createClaim({ statement: "A claim drilled once already." });
    await svc.requestDrillDown(node.id, "first pass");
    await svc.markDrillDownConsumed([node.id]);

    await svc.requestDrillDown(node.id, "second pass");
    const queued = await svc.listDrillDownQueue();
    expect(queued.map((n) => n.id)).toEqual([node.id]);
    expect(queued[0].drillDownConsumedAt).toBeNull();
    expect(queued[0].drillDownNote).toBe("second pass");
  });

  it("cancelling clears the request entirely", async () => {
    const { node } = await svc.createClaim({ statement: "A claim queued by mistake." });
    await svc.requestDrillDown(node.id, "oops");
    await svc.cancelDrillDown(node.id);

    expect(await svc.listDrillDownQueue()).toHaveLength(0);
    const after = await svc.getNode(node.id);
    expect(after!.drillDownRequestedAt).toBeNull();
    expect(after!.drillDownNote).toBeNull();
  });

  it("stores an empty note as null rather than blank text", async () => {
    const { node } = await svc.createClaim({ statement: "A claim queued without a note." });
    await svc.requestDrillDown(node.id, "   ");
    expect((await svc.getNode(node.id))!.drillDownNote).toBeNull();
  });

  it("queues in insertion order, appending to the end", async () => {
    const a = await svc.createClaim({ statement: "First claim queued." });
    const b = await svc.createClaim({ statement: "Second claim queued." });
    const c = await svc.createClaim({ statement: "Third claim queued." });
    for (const n of [a, b, c]) await svc.requestDrillDown(n.node.id);

    expect((await svc.listDrillDownQueue(10)).map((n) => n.statement)).toEqual([
      "First claim queued.",
      "Second claim queued.",
      "Third claim queued.",
    ]);
  });

  it("persists a reordering and keeps it across rescoring", async () => {
    const a = await svc.createClaim({ statement: "Alpha." });
    const b = await svc.createClaim({ statement: "Beta." });
    const c = await svc.createClaim({ statement: "Gamma." });
    for (const n of [a, b, c]) await svc.requestDrillDown(n.node.id);

    // Operator drags Gamma to the top.
    await svc.reorderDrillDownQueue([c.node.id, a.node.id, b.node.id]);
    expect((await svc.listDrillDownQueue(10)).map((n) => n.statement)).toEqual(["Gamma.", "Alpha.", "Beta."]);

    // Impact is derived and moves on its own; the operator's order must not.
    await svc.recomputeAllImpact(100);
    expect((await svc.listDrillDownQueue(10)).map((n) => n.statement)).toEqual(["Gamma.", "Alpha.", "Beta."]);
  });

  it("appends a newly queued finding below an existing manual order", async () => {
    const a = await svc.createClaim({ statement: "Alpha." });
    const b = await svc.createClaim({ statement: "Beta." });
    await svc.requestDrillDown(a.node.id);
    await svc.requestDrillDown(b.node.id);
    await svc.reorderDrillDownQueue([b.node.id, a.node.id]);

    const c = await svc.createClaim({ statement: "Gamma." });
    await svc.requestDrillDown(c.node.id);
    expect((await svc.listDrillDownQueue(10)).map((n) => n.statement)).toEqual(["Beta.", "Alpha.", "Gamma."]);
  });

  it(`refuses to queue more than ${MAX_DRILL_DOWN_QUEUE} findings`, async () => {
    const nodes = [];
    for (let i = 0; i < MAX_DRILL_DOWN_QUEUE + 1; i++) {
      nodes.push((await svc.createClaim({ statement: `Queued claim number ${i}.` })).node);
    }
    for (let i = 0; i < MAX_DRILL_DOWN_QUEUE; i++) await svc.requestDrillDown(nodes[i].id);

    await expect(svc.requestDrillDown(nodes[MAX_DRILL_DOWN_QUEUE].id)).rejects.toThrow(DrillDownQueueFullError);
    expect(await svc.listDrillDownQueue(50)).toHaveLength(MAX_DRILL_DOWN_QUEUE);

    // Freeing a slot lets the next one in.
    await svc.cancelDrillDown(nodes[0].id);
    await expect(svc.requestDrillDown(nodes[MAX_DRILL_DOWN_QUEUE].id)).resolves.not.toThrow();
  });

  it("lets a full queue still have its notes edited", async () => {
    const nodes = [];
    for (let i = 0; i < MAX_DRILL_DOWN_QUEUE; i++) {
      const n = (await svc.createClaim({ statement: `Queued claim number ${i}.` })).node;
      await svc.requestDrillDown(n.id, "first note");
      nodes.push(n);
    }
    // Re-queueing something already pending is an edit, not a new entry.
    await expect(svc.requestDrillDown(nodes[0].id, "revised note")).resolves.not.toThrow();
    expect((await svc.getNode(nodes[0].id))!.drillDownNote).toBe("revised note");
  });

  it("drops a cancelled finding out of the ordering", async () => {
    const a = await svc.createClaim({ statement: "Alpha." });
    const b = await svc.createClaim({ statement: "Beta." });
    await svc.requestDrillDown(a.node.id);
    await svc.requestDrillDown(b.node.id);

    await svc.cancelDrillDown(a.node.id);
    expect((await svc.getNode(a.node.id))!.drillDownPosition).toBeNull();
    expect((await svc.listDrillDownQueue(10)).map((n) => n.statement)).toEqual(["Beta."]);
  });

  it("ignores ids that are not in the queue when reordering", async () => {
    const a = await svc.createClaim({ statement: "Alpha." });
    const notQueued = await svc.createClaim({ statement: "Not queued." });
    await svc.requestDrillDown(a.node.id);

    await svc.reorderDrillDownQueue([notQueued.node.id, a.node.id]);
    expect((await svc.listDrillDownQueue(10)).map((n) => n.statement)).toEqual(["Alpha."]);
    expect((await svc.getNode(notQueued.node.id))!.drillDownPosition).toBeNull();
  });
});
