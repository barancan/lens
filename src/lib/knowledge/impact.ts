import type { ImpactComponents, NodeStatus, NodeType, RelationshipType } from "@/lib/types";

/**
 * Scores how much drilling into a finding would move OTHER findings —
 * the operator's "would pulling this thread unlock the rest?" question.
 *
 * Like `computeConfidence`, this is a transparent, inspectable HEURISTIC and
 * not a calibrated probability. It exists so an operator can see exactly why
 * one finding outranks another (which neighbours, what weight) rather than
 * trusting an opaque model. Read the output as "where the graph says the
 * leverage is", not "how much you will learn".
 *
 * It differs from confidence in one important way: confidence is LOCAL to a
 * node (its own evidence), while impact is a property of the node's
 * neighbourhood, so it goes stale when neighbours change and is recomputed in
 * batches rather than on read.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The bit of a finding that determines how much room it has left to move. */
export interface ImpactNodeInput {
  status: NodeStatus;
  /** Null when no evidence has been recorded yet. */
  confidence: number | null;
  /** Distinct sources backing this finding. A replication gap leaves headroom. */
  distinctSourceCount: number;
}

/** How a finding is connected to a neighbour. */
export type ImpactLink =
  | { kind: "edge"; relationshipType: RelationshipType; direction: "incoming" | "outgoing" }
  | { kind: "similar"; similarity: number };

export interface ImpactNeighbour extends ImpactNodeInput {
  nodeId: string;
  statement: string;
  type: NodeType;
  link: ImpactLink;
}

export interface ImpactSubject extends ImpactNodeInput {
  /**
   * Whether this finding has an embedding. Without one we never looked for
   * latent neighbours, so "no neighbours" means "unknown", not "isolated".
   */
  hasEmbedding: boolean;
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

/**
 * How much room a finding has left to move, by status. `contested` is the
 * maximum: a live disagreement is the most drillable thing in the base.
 * `answered` and `superseded` are hard zeroes — and are filtered out as
 * neighbour candidates in `match_neighbour_nodes`, so the two agree.
 */
const STATUS_HEADROOM: Record<NodeStatus, number> = {
  contested: 1,
  open: 1,
  unresolved: 0.9,
  weak: 0.6,
  supported: 0.3,
  answered: 0,
  superseded: 0,
};

/**
 * Coupling: if THIS node moves, how much does the neighbour move? Direction is
 * from the scored node's point of view — "incoming" means the edge points AT it.
 *
 * NOTE: only `contradicts`, `raises` and `derived_from` are ever written today
 * (see `applyKnowledgeUpdates`, `createQuestion`, `createInsight`); the rest of
 * the enum is unused. Those three therefore carry the score in practice. The
 * others are weighted anyway so the heuristic is correct the day they appear —
 * `depends_on` especially, which is the purest unlock signal there is.
 */
const EDGE_COUPLING: Record<RelationshipType, { incoming: number; outgoing: number }> = {
  // Symmetric: resolving the disagreement settles both sides.
  contradicts: { incoming: 1, outgoing: 1 },
  // Incoming means "X depends on me", so resolving this unblocks X.
  depends_on: { incoming: 1, outgoing: 0.3 },
  // Outgoing: this finding opened that question. Incoming: it IS the question,
  // and answering it feeds back to whatever raised it.
  raises: { incoming: 0.8, outgoing: 0.6 },
  // Incoming: agent insights were built on this, so they move when it moves.
  derived_from: { incoming: 0.7, outgoing: 0.3 },
  supports: { incoming: 0.6, outgoing: 0.6 },
  refines: { incoming: 0.5, outgoing: 0.5 },
  related_to: { incoming: 0.3, outgoing: 0.3 },
  supersedes: { incoming: 0.1, outgoing: 0.1 },
};

/**
 * Latent (embedding) links are a hint that work here is on-topic, never a
 * dependency — so they are capped strictly below the weakest real edge and a
 * guess from cosine distance never outranks a recorded relationship. Derived
 * from EDGE_COUPLING rather than hardcoded, so the invariant survives retuning.
 */
const SIMILARITY_FLOOR = 0.75;
const WEAKEST_EDGE_COUPLING = Math.min(...Object.values(EDGE_COUPLING).flatMap((w) => [w.incoming, w.outgoing]));
const SIMILARITY_MAX_COUPLING = WEAKEST_EDGE_COUPLING * 0.8;

/** Coupled mass at which reach is 0.5. Gives the 10th neighbour far less than the 2nd. */
const REACH_HALF_SATURATION = 1.5;

/**
 * A finding backed by a single source has a replication gap worth closing,
 * independently of how confident the evidence looks. Indexed by distinct
 * source count, clamped at 3.
 */
const REPLICATION_HEADROOM = [1, 1, 0.9, 0.8];

// ---------------------------------------------------------------------------

export type { ImpactComponents, ImpactExplanation } from "@/lib/types";

export interface ImpactResult {
  impact: number | null;
  components: ImpactComponents;
  /** Operator-facing, e.g. "2 agent insights were derived from this". */
  reasons: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * How decisively the recorded evidence has settled the question, inverted.
 *
 * `computeConfidence` already folds evidence strength, independence and mass
 * into one number, and it is symmetric around 0.5 — so `1 - |2c - 1|` peaks
 * where the evidence is genuinely undecided and falls to zero where it has
 * landed firmly either way. Using a raw evidence COUNT here would be actively
 * wrong: a contested claim has plenty of evidence and maximal headroom.
 */
function evidenceHeadroom(confidence: number | null): number {
  if (confidence == null) return 1;
  return 1 - Math.abs(2 * confidence - 1);
}

function replicationHeadroom(distinctSourceCount: number): number {
  const i = clamp(Math.floor(distinctSourceCount), 0, REPLICATION_HEADROOM.length - 1);
  return REPLICATION_HEADROOM[i];
}

/** How much room a finding has left to move. 0 means drilling it changes nothing. */
export function headroomOf(node: ImpactNodeInput): number {
  const status = STATUS_HEADROOM[node.status];
  if (status === 0) return 0;
  return round(status * evidenceHeadroom(node.confidence) * replicationHeadroom(node.distinctSourceCount));
}

/** The weight of a single link, ignoring what the neighbour stands to gain. */
export function linkCoupling(link: ImpactLink): number {
  if (link.kind === "edge") return EDGE_COUPLING[link.relationshipType][link.direction];
  const scaled = (link.similarity - SIMILARITY_FLOOR) / (1 - SIMILARITY_FLOOR);
  return clamp(scaled, 0, 1) * SIMILARITY_MAX_COUPLING;
}

function truncate(statement: string, max = 80): string {
  const clean = statement.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Picks the verb form that agrees with `n`, so reason text reads correctly at 1. */
function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

interface Scored {
  neighbour: ImpactNeighbour;
  coupling: number;
  gain: number;
}

/**
 * impact = headroom(node) × reach(neighbours)
 *
 * Multiplicative on purpose. A finding that cannot move itself transmits
 * nothing to its neighbours, and a finding whose neighbours are all settled
 * unlocks nothing however well connected it is. Drilling pays off only when
 * both hold — which is exactly the operator's question.
 *
 * `reach = mass / (mass + K)` saturates, so a crowd of weak links cannot
 * outweigh one real dependency, and the score approaches but never reaches 1.
 */
export function computeImpact(node: ImpactSubject, neighbours: readonly ImpactNeighbour[]): ImpactResult {
  // Keep the strongest link per neighbour, so a node reachable by both an edge
  // and by similarity is counted once — as the edge.
  const strongest = new Map<string, Scored>();
  for (const neighbour of neighbours) {
    const coupling = linkCoupling(neighbour.link);
    if (coupling <= 0) continue;
    const existing = strongest.get(neighbour.nodeId);
    if (!existing || coupling > existing.coupling) {
      strongest.set(neighbour.nodeId, { neighbour, coupling, gain: coupling * headroomOf(neighbour) });
    }
  }

  const scored = [...strongest.values()].sort((a, b) => b.gain - a.gain);
  const headroom = headroomOf(node);
  const couplingMass = scored.reduce((sum, s) => sum + s.gain, 0);
  const reach = couplingMass / (couplingMass + REACH_HALF_SATURATION);

  const components: ImpactComponents = {
    headroom,
    statusHeadroom: STATUS_HEADROOM[node.status],
    evidenceHeadroom: round(evidenceHeadroom(node.confidence)),
    replicationHeadroom: replicationHeadroom(node.distinctSourceCount),
    reach: round(reach),
    couplingMass: round(couplingMass),
    edgeNeighbours: scored.filter((s) => s.neighbour.link.kind === "edge").length,
    similarNeighbours: scored.filter((s) => s.neighbour.link.kind === "similar").length,
  };

  // No neighbours and no embedding means we never looked, which is not the
  // same as having looked and found nothing.
  if (scored.length === 0 && !node.hasEmbedding) {
    return {
      impact: null,
      components,
      reasons: ["No links and no embedding yet, so there is nothing to score. Run Backfill embeddings."],
    };
  }

  return {
    impact: round(clamp(headroom * reach, 0, 1)),
    components,
    reasons: buildReasons(node, headroom, scored),
  };
}

function edgesOf(scored: readonly Scored[], relationshipType: RelationshipType, direction?: "incoming" | "outgoing") {
  return scored.filter(
    (s) =>
      s.neighbour.link.kind === "edge" &&
      s.neighbour.link.relationshipType === relationshipType &&
      (direction === undefined || s.neighbour.link.direction === direction),
  );
}

function buildReasons(node: ImpactSubject, headroom: number, scored: readonly Scored[]): string[] {
  if (headroom === 0) {
    return [`This finding is ${node.status}; drilling into it would not change anything.`];
  }
  if (scored.length === 0) {
    return ["Nothing else in the knowledge base connects to this finding yet."];
  }

  const reasons: string[] = [];
  // Only neighbours that can still move are worth mentioning as beneficiaries.
  const movable = scored.filter((s) => headroomOf(s.neighbour) > 0);

  const contradicts = edgesOf(movable, "contradicts");
  if (contradicts.length > 0) {
    reasons.push(`Resolving it would settle ${plural(contradicts.length, "open contradiction")}.`);
  }

  const dependents = edgesOf(movable, "depends_on", "incoming");
  if (dependents.length > 0) {
    reasons.push(`${plural(dependents.length, "unsettled finding")} ${agree(dependents.length, "depends", "depend")} on this one.`);
  }

  const insights = edgesOf(movable, "derived_from", "incoming");
  if (insights.length > 0) {
    reasons.push(`${plural(insights.length, "agent insight")} ${agree(insights.length, "was", "were")} derived from this.`);
  }

  const raised = edgesOf(movable, "raises", "outgoing");
  if (raised.length > 0) {
    reasons.push(`It opened ${plural(raised.length, "still-unanswered question")}.`);
  }

  const raisers = edgesOf(movable, "raises", "incoming");
  if (raisers.length > 0) {
    reasons.push(`Answering it would feed back to ${plural(raisers.length, "finding")} that ${agree(raisers.length, "raised", "raised")} it.`);
  }

  const top = movable[0];
  if (top) {
    const how = top.neighbour.link.kind === "edge" ? top.neighbour.link.relationshipType.replace(/_/g, " ") : "closely related";
    reasons.push(`Biggest beneficiary (${how}, ${top.neighbour.status}): "${truncate(top.neighbour.statement)}"`);
  }

  if (movable.length > 0 && movable.every((s) => s.neighbour.link.kind === "similar")) {
    const best = Math.max(...movable.map((s) => (s.neighbour.link.kind === "similar" ? s.neighbour.link.similarity : 0)));
    reasons.push(`Connected only by similarity so far (up to ${best.toFixed(2)}) — no relationship has been recorded.`);
  }

  if (!node.hasEmbedding) {
    reasons.push("No embedding yet, so similar findings were not counted. Run Backfill embeddings.");
  }

  if (node.confidence != null && evidenceHeadroom(node.confidence) < 0.35) {
    reasons.push(`Evidence has largely settled this (confidence ${node.confidence.toFixed(2)}), so there is less left to move.`);
  }

  return reasons;
}
