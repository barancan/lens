import { describe, expect, it } from "vitest";
import {
  computeImpact,
  headroomOf,
  linkCoupling,
  type ImpactLink,
  type ImpactNeighbour,
  type ImpactSubject,
} from "@/lib/knowledge/impact";
import { RELATIONSHIP_TYPES, type NodeStatus, type RelationshipType } from "@/lib/types";

function subject(patch: Partial<ImpactSubject> = {}): ImpactSubject {
  return { status: "unresolved", confidence: null, distinctSourceCount: 0, hasEmbedding: true, ...patch };
}

let seq = 0;
function neighbour(status: NodeStatus, link: ImpactLink, patch: Partial<ImpactNeighbour> = {}): ImpactNeighbour {
  return {
    nodeId: `n${++seq}`,
    statement: `neighbour ${seq}`,
    type: "claim",
    status,
    confidence: null,
    distinctSourceCount: 0,
    link,
    ...patch,
  };
}

function edge(relationshipType: RelationshipType, direction: "incoming" | "outgoing" = "incoming"): ImpactLink {
  return { kind: "edge", relationshipType, direction };
}

function similar(similarity: number): ImpactLink {
  return { kind: "similar", similarity };
}

describe("computeImpact", () => {
  it("returns null when there is nothing to go on (no links, no embedding)", () => {
    const result = computeImpact(subject({ hasEmbedding: false }), []);
    expect(result.impact).toBeNull();
    expect(result.reasons[0]).toMatch(/nothing to score/i);
  });

  it("distinguishes 'never looked' from 'looked and found nothing'", () => {
    expect(computeImpact(subject({ hasEmbedding: true }), []).impact).toBe(0);
    expect(computeImpact(subject({ hasEmbedding: false }), []).impact).toBeNull();
  });

  it("scores terminal findings zero — drilling them changes nothing", () => {
    for (const status of ["superseded", "answered"] as NodeStatus[]) {
      const result = computeImpact(subject({ status }), [neighbour("open", edge("contradicts"))]);
      expect(result.impact).toBe(0);
      expect(result.reasons[0]).toContain(status);
    }
  });

  // --- The three edge types the agent actually writes today -----------------
  // Only `contradicts`, `raises` and `derived_from` are ever created (see
  // applyKnowledgeUpdates / createQuestion / createInsight), so these carry the
  // score in practice and deserve the closest scrutiny.

  it("scores a contested claim that contradicts other live claims highly", () => {
    const result = computeImpact(subject({ status: "contested", confidence: 0.5 }), [
      neighbour("contested", edge("contradicts"), { confidence: 0.5 }),
      neighbour("unresolved", edge("contradicts"), { confidence: 0.5 }),
    ]);
    expect(result.impact!).toBeGreaterThan(0.5);
    expect(result.reasons).toContain("Resolving it would settle 2 open contradictions.");
  });

  it("rewards a finding that agent insights were derived from", () => {
    const result = computeImpact(subject({ status: "contested" }), [
      neighbour("open", edge("derived_from", "incoming"), { type: "insight" }),
      neighbour("open", edge("derived_from", "incoming"), { type: "insight" }),
    ]);
    expect(result.impact!).toBeGreaterThan(0.3);
    expect(result.reasons).toContain("2 agent insights were derived from this.");
  });

  it("rewards a finding that opened still-open questions", () => {
    const result = computeImpact(subject({ status: "unresolved" }), [
      neighbour("open", edge("raises", "outgoing"), { type: "question" }),
    ]);
    expect(result.impact!).toBeGreaterThan(0);
    expect(result.reasons).toContain("It opened 1 still-unanswered question.");
  });

  it("treats an open question as high-leverage for the findings that raised it", () => {
    const result = computeImpact(subject({ status: "open" }), [
      neighbour("contested", edge("raises", "incoming"), { confidence: 0.5 }),
      neighbour("unresolved", edge("raises", "incoming")),
    ]);
    expect(result.impact!).toBeGreaterThan(0.4);
    expect(result.reasons).toContain("Answering it would feed back to 2 findings that raised it.");
  });

  it("treats contradicts as symmetric but depends_on as directional", () => {
    const inc = (r: RelationshipType) => computeImpact(subject(), [neighbour("open", edge(r, "incoming"))]).impact!;
    const out = (r: RelationshipType) => computeImpact(subject(), [neighbour("open", edge(r, "outgoing"))]).impact!;
    expect(inc("contradicts")).toBe(out("contradicts"));
    expect(inc("depends_on")).toBeGreaterThan(out("depends_on"));
  });

  // --- Structure vs. latent signal -----------------------------------------

  it("never lets a latent similarity outweigh ANY recorded edge", () => {
    const perfect = linkCoupling(similar(1));
    const everyEdge = RELATIONSHIP_TYPES.flatMap((r) => [linkCoupling(edge(r, "incoming")), linkCoupling(edge(r, "outgoing"))]);
    expect(perfect).toBeLessThan(Math.min(...everyEdge));
  });

  it("ranks five latent neighbours below one recorded contradiction", () => {
    const latent = computeImpact(subject(), Array.from({ length: 5 }, () => neighbour("open", similar(0.85))));
    const recorded = computeImpact(subject(), [neighbour("open", edge("contradicts"))]);
    expect(latent.impact!).toBeLessThan(recorded.impact!);
  });

  it("ignores similarity below the floor and scales above it", () => {
    expect(linkCoupling(similar(0.5))).toBe(0);
    expect(linkCoupling(similar(0.75))).toBe(0);
    expect(linkCoupling(similar(0.9))).toBeGreaterThan(linkCoupling(similar(0.8)));
  });

  it("counts a node linked by BOTH an edge and similarity only once, as the edge", () => {
    const shared = {
      nodeId: "same",
      statement: "same",
      type: "claim" as const,
      status: "open" as NodeStatus,
      confidence: null,
      distinctSourceCount: 0,
    };
    const both = computeImpact(subject(), [
      { ...shared, link: edge("contradicts") },
      { ...shared, link: similar(0.99) },
    ]);
    const edgeOnly = computeImpact(subject(), [{ ...shared, link: edge("contradicts") }]);

    expect(both.components.edgeNeighbours).toBe(1);
    expect(both.components.similarNeighbours).toBe(0);
    expect(both.impact).toBe(edgeOnly.impact);
  });

  // --- Shape of the score ---------------------------------------------------

  it("requires BOTH headroom and reach — either alone scores near zero", () => {
    const live = [neighbour("contested", edge("contradicts")), neighbour("open", edge("contradicts"))];
    const both = computeImpact(subject({ status: "contested" }), live);

    // Well connected, but this finding itself has nothing left to give.
    const noHeadroom = computeImpact(subject({ status: "supported", confidence: 0.95, distinctSourceCount: 4 }), live);
    // Plenty of headroom, but nothing connected stands to gain.
    const noReach = computeImpact(subject({ status: "contested" }), [
      neighbour("superseded", edge("contradicts")),
      neighbour("answered", edge("raises", "outgoing")),
    ]);

    expect(both.impact!).toBeGreaterThan(0.5);
    expect(noHeadroom.impact!).toBeLessThan(0.05);
    expect(noReach.impact).toBe(0);
  });

  it("saturates: the 10th neighbour adds far less than the 2nd", () => {
    const at = (n: number) =>
      computeImpact(subject(), Array.from({ length: n }, () => neighbour("open", edge("contradicts")))).impact!;
    const secondAdds = at(2) - at(1);
    const tenthAdds = at(10) - at(9);
    expect(tenthAdds).toBeGreaterThan(0);
    expect(tenthAdds).toBeLessThan(secondAdds / 4);
    expect(at(50)).toBeLessThanOrEqual(1);
  });

  it("never decreases when a neighbour is added", () => {
    const acc: ImpactNeighbour[] = [];
    let previous = computeImpact(subject(), acc).impact!;
    for (const status of ["open", "supported", "weak", "contested", "unresolved"] as NodeStatus[]) {
      acc.push(neighbour(status, edge("contradicts")));
      const next = computeImpact(subject(), acc).impact!;
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });

  it("keeps impact in [0,1] and rounded to 3 decimals", () => {
    const result = computeImpact(subject(), Array.from({ length: 40 }, () => neighbour("open", edge("contradicts"))));
    expect(result.impact!).toBeGreaterThanOrEqual(0);
    expect(result.impact!).toBeLessThanOrEqual(1);
    expect(result.impact).toBe(Math.round(result.impact! * 1000) / 1000);
  });

  // --- Headroom -------------------------------------------------------------

  it("gives undecided evidence more headroom than evidence that has landed", () => {
    const undecided = headroomOf({ status: "contested", confidence: 0.5, distinctSourceCount: 2 });
    const settledFor = headroomOf({ status: "contested", confidence: 0.95, distinctSourceCount: 2 });
    const settledAgainst = headroomOf({ status: "contested", confidence: 0.05, distinctSourceCount: 2 });
    expect(undecided).toBeGreaterThan(settledFor);
    expect(undecided).toBeGreaterThan(settledAgainst);
  });

  it("does not punish a contested claim for having accumulated evidence", () => {
    // The whole point of the confidence-based term: a contested claim with lots
    // of unresolved evidence must stay maximally drillable.
    const thin = headroomOf({ status: "contested", confidence: 0.5, distinctSourceCount: 1 });
    const thick = headroomOf({ status: "contested", confidence: 0.5, distinctSourceCount: 3 });
    expect(thick).toBeGreaterThan(0.5);
    expect(thin).toBeGreaterThanOrEqual(thick);
  });

  it("leaves headroom for a single-source finding (replication gap)", () => {
    const oneSource = headroomOf({ status: "supported", confidence: 0.8, distinctSourceCount: 1 });
    const threeSources = headroomOf({ status: "supported", confidence: 0.8, distinctSourceCount: 3 });
    expect(oneSource).toBeGreaterThan(threeSources);
  });

  it("treats a finding with no evidence as fully open", () => {
    expect(computeImpact(subject({ confidence: null }), []).components.evidenceHeadroom).toBe(1);
  });

  // --- Explainability -------------------------------------------------------

  it("names the biggest beneficiary so the operator can see who moves", () => {
    const result = computeImpact(subject({ status: "contested" }), [
      neighbour("supported", edge("related_to"), { statement: "a settled aside", confidence: 0.95, distinctSourceCount: 4 }),
      neighbour("contested", edge("contradicts"), { statement: "the live disagreement", confidence: 0.5 }),
    ]);
    expect(result.reasons.some((r) => r.includes("the live disagreement"))).toBe(true);
  });

  it("writes reason text that agrees in number at exactly one neighbour", () => {
    const one = (link: ImpactLink, patch: Partial<ImpactNeighbour> = {}) =>
      computeImpact(subject({ status: "contested" }), [neighbour("open", link, patch)]).reasons;

    expect(one(edge("depends_on", "incoming"))).toContain("1 unsettled finding depends on this one.");
    expect(one(edge("derived_from", "incoming"), { type: "insight" })).toContain("1 agent insight was derived from this.");
    expect(one(edge("raises", "outgoing"), { type: "question" })).toContain("It opened 1 still-unanswered question.");
    expect(one(edge("raises", "incoming"))).toContain("Answering it would feed back to 1 finding that raised it.");
    expect(one(edge("contradicts"))).toContain("Resolving it would settle 1 open contradiction.");

    // No reason line should read like a plural applied to a single item.
    for (const link of [edge("depends_on"), edge("derived_from"), edge("raises", "outgoing"), edge("contradicts")]) {
      for (const line of one(link)) expect(line).not.toMatch(/\b1 \w+s\b/);
    }
  });

  it("flags when a finding is connected by similarity alone", () => {
    const result = computeImpact(subject(), [neighbour("open", similar(0.9))]);
    expect(result.reasons.some((r) => /only by similarity/i.test(r))).toBe(true);
  });

  it("tells the operator when a missing embedding limited the score", () => {
    const result = computeImpact(subject({ hasEmbedding: false }), [neighbour("open", edge("contradicts"))]);
    expect(result.impact).not.toBeNull();
    expect(result.reasons.some((r) => /backfill embeddings/i.test(r))).toBe(true);
  });

  it("exposes the full breakdown so the number can be audited", () => {
    const result = computeImpact(subject({ status: "weak", confidence: 0.3, distinctSourceCount: 2 }), [
      neighbour("open", edge("contradicts")),
      neighbour("open", similar(0.9)),
    ]);
    const c = result.components;
    expect(c.headroom).toBeCloseTo(c.statusHeadroom * c.evidenceHeadroom * c.replicationHeadroom, 3);
    expect(result.impact).toBeCloseTo(Math.round(c.headroom * c.reach * 1000) / 1000, 3);
    expect(c.edgeNeighbours).toBe(1);
    expect(c.similarNeighbours).toBe(1);
    expect(c.couplingMass).toBeGreaterThan(0);
  });
});
