import * as edgesRepo from "@/lib/repo/edges";
import * as evidenceRepo from "@/lib/repo/evidence";
import * as knowledgeRepo from "@/lib/repo/knowledge";
import * as sourcesRepo from "@/lib/repo/sources";
import type { SourceDocument } from "@/lib/research/types";
import {
  NODE_TYPES,
  type Evidence,
  type EvidenceStrength,
  type EvidenceType,
  type EvidenceWithSource,
  type Independence,
  type KnowledgeEdge,
  type KnowledgeNode,
  type NodeHistoryEntry,
  type NodeOrigin,
  type NodeStatus,
  type NodeType,
  type RelationshipType,
  type Source,
  type SourceChunk,
  type SourceType,
} from "@/lib/types";
import { chunkText } from "./chunking";
import { computeConfidence } from "./confidence";
import { computeImpact, headroomOf, linkCoupling, type ImpactLink, type ImpactNeighbour, type ImpactResult } from "./impact";
import {
  renderKnowledgeContext,
  searchKnowledge as searchKnowledgeImpl,
  type KnowledgeContext,
  type RetrievalFilters,
} from "./retrieval";

export { renderKnowledgeContext };
export type { KnowledgeContext, RetrievalFilters, RetrievedChunk, RetrievedNode } from "./retrieval";

/** Raised when an operation would violate the provenance rules on evidence. */
export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceError";
  }
}

// ---------------------------------------------------------------------------
// Shapes not already covered by src/lib/types.ts
// ---------------------------------------------------------------------------

export interface UpsertSourceResult {
  source: Source;
  chunks: SourceChunk[];
  created: boolean;
}

export interface ListSourcesFilters {
  sourceTypes?: SourceType[];
  publishedAfter?: string;
  tags?: string[];
  text?: string;
  limit?: number;
  offset?: number;
}

export interface CreateNodeInput {
  statement: string;
  summary?: string | null;
  confidence?: number | null;
  status?: NodeStatus;
  tags?: string[];
  origin?: NodeOrigin;
  metadata?: Record<string, unknown>;
  runId?: string | null;
}

export interface CreateInsightInput {
  statement: string;
  summary?: string | null;
  /** At least one existing node id this insight was derived from. */
  derivedFrom: string[];
  confidence?: number | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  runId?: string | null;
}

export interface CreateQuestionInput {
  statement: string;
  summary?: string | null;
  raisedBy?: string[];
  tags?: string[];
  origin?: "agent_generated" | "operator";
  metadata?: Record<string, unknown>;
  runId?: string | null;
}

export interface CreateNodeResult {
  node: KnowledgeNode;
  created: boolean;
}

export interface ListNodesFilters {
  types?: NodeType[];
  statuses?: NodeStatus[];
  origins?: NodeOrigin[];
  tags?: string[];
  minConfidence?: number;
  minImpact?: number;
  text?: string;
  /** Default "recent". "impact" ranks by leverage, unscored nodes last. */
  orderBy?: "recent" | "impact";
  limit?: number;
  offset?: number;
}

export interface RelatedNode {
  edge: KnowledgeEdge;
  node: KnowledgeNode;
  direction: "outgoing" | "incoming";
}

export interface ClaimDetail {
  node: KnowledgeNode;
  supporting: EvidenceWithSource[];
  contradicting: EvidenceWithSource[];
  contextual: EvidenceWithSource[];
  related: RelatedNode[];
  questions: KnowledgeNode[];
  sources: Source[];
  history: NodeHistoryEntry[];
  /** Neighbours the stored impact score says would move, for the detail page. */
  impactNeighbours: ImpactNeighbourDetail[];
}

/** A neighbour named in the impact breakdown, resolved for display. */
export interface ImpactNeighbourDetail {
  node: KnowledgeNode;
  link: ImpactLink;
  /** This neighbour's share of the coupled mass behind the score. */
  gain: number;
}

export interface AddEvidenceInput {
  claimId: string;
  sourceId: string;
  quote: string;
  evidenceType: EvidenceType;
  strength?: EvidenceStrength;
  independence?: Independence;
  notes?: string | null;
  sourceChunkId?: string | null;
  runId?: string | null;
}

export interface EvidenceListFilters {
  evidenceTypes?: EvidenceType[];
  sourceId?: string;
  claimId?: string;
  limit?: number;
  offset?: number;
}

export type EvidenceListItem = EvidenceWithSource & { claimStatement: string };

export interface LinkKnowledgeInput {
  fromId: string;
  toId: string;
  relationshipType: RelationshipType;
  confidence?: number | null;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UpdateConfidenceInput {
  confidence: number | null;
  status: NodeStatus;
  reason: string;
  runId?: string | null;
}

export interface KnowledgeStats {
  nodesByType: Record<NodeType, number>;
  nodesByStatus: Record<string, number>;
  sources: number;
  evidence: number;
  edges: number;
}

export interface KnowledgeServiceDeps {
  embed: (texts: string[]) => Promise<number[][]>;
}

export interface KnowledgeService {
  // Sources
  upsertSource(doc: SourceDocument & { tags?: string[]; maxChars?: number }): Promise<UpsertSourceResult>;
  getSource(id: string): Promise<Source | null>;
  listSources(filters?: ListSourcesFilters): Promise<Source[]>;
  getSourceChunks(sourceId: string): Promise<SourceChunk[]>;
  findSource(query: { doi?: string | null; url?: string | null }): Promise<Source | null>;

  // Nodes
  createClaim(input: CreateNodeInput): Promise<CreateNodeResult>;
  createObservation(input: CreateNodeInput): Promise<CreateNodeResult>;
  createHypothesis(input: CreateNodeInput): Promise<CreateNodeResult>;
  createInsight(input: CreateInsightInput): Promise<CreateNodeResult>;
  createQuestion(input: CreateQuestionInput): Promise<CreateNodeResult>;
  getNode(id: string): Promise<KnowledgeNode | null>;
  listNodes(filters?: ListNodesFilters): Promise<KnowledgeNode[]>;
  updateNodeStatus(
    id: string,
    status: NodeStatus,
    reason: string,
    runId?: string | null,
  ): Promise<KnowledgeNode | null>;

  // Claim detail
  getClaim(id: string): Promise<ClaimDetail | null>;

  // Evidence
  getEvidenceForClaim(id: string): Promise<EvidenceWithSource[]>;
  getEvidenceAgainstClaim(id: string): Promise<EvidenceWithSource[]>;
  listEvidence(filters?: EvidenceListFilters): Promise<EvidenceListItem[]>;
  addEvidence(input: AddEvidenceInput): Promise<{ evidence: Evidence; created: boolean }>;

  // Graph
  linkKnowledge(input: LinkKnowledgeInput): Promise<KnowledgeEdge>;
  findRelatedKnowledge(id: string): Promise<RelatedNode[]>;

  // Confidence
  updateConfidence(id: string, input: UpdateConfidenceInput): Promise<KnowledgeNode | null>;
  recomputeConfidence(id: string, reason: string, runId?: string | null): Promise<KnowledgeNode | null>;

  // Retrieval
  searchKnowledge(query: string, filters?: RetrievalFilters): Promise<KnowledgeContext>;

  // Impact
  recomputeImpact(ids: string[], opts?: { includeNeighbours?: boolean }): Promise<number>;
  recomputeAllImpact(limit?: number): Promise<number>;

  // Drill-down queue
  requestDrillDown(id: string, note?: string | null): Promise<KnowledgeNode | null>;
  reorderDrillDownQueue(ids: string[]): Promise<void>;
  cancelDrillDown(id: string): Promise<KnowledgeNode | null>;
  listDrillDownQueue(limit?: number): Promise<KnowledgeNode[]>;
  markDrillDownConsumed(ids: string[]): Promise<void>;

  // Maintenance
  backfillEmbeddings(limit?: number): Promise<{ nodes: number; chunks: number }>;
  stats(): Promise<KnowledgeStats>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** How much of a new source's text we bother chunking/embedding. Full text is stored untruncated for provenance. */
const DEFAULT_CHUNKING_BUDGET_CHARS = 20_000;
/**
 * How many findings may sit in the drill-down queue at once. A hard cap keeps
 * it a deliberate shortlist the operator can actually order by hand, rather
 * than a backlog.
 */
export const MAX_DRILL_DOWN_QUEUE = 10;

/** Thrown by `requestDrillDown` when the queue is already full. */
export class DrillDownQueueFullError extends Error {
  constructor() {
    super(`The drill-down queue is full (${MAX_DRILL_DOWN_QUEUE}). Remove something before queueing another finding.`);
    this.name = "DrillDownQueueFullError";
  }
}

/** Embedding-similarity dedupe threshold for claims and questions. */
const DEDUPE_SIMILARITY_THRESHOLD = 0.95;
/** Tolerance for float32 round-tripping through the `real` column when checking whether confidence changed. */
const CONFIDENCE_EPSILON = 6e-4;

function confidenceEquals(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < CONFIDENCE_EPSILON;
}

/** Normalizes whitespace, case, and unicode quotes/dashes so quote matching is robust to incidental formatting. */
function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function containsQuote(haystack: string | null | undefined, quote: string): boolean {
  if (!haystack) return false;
  return normalizeForMatch(haystack).includes(normalizeForMatch(quote));
}

const EVIDENCE_TARGETABLE_TYPES: readonly NodeType[] = ["claim", "hypothesis", "observation"];

export function createKnowledgeService(deps: KnowledgeServiceDeps): KnowledgeService {
  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  async function chunkAndStore(sourceId: string, text: string): Promise<SourceChunk[]> {
    const pieces = chunkText(text);
    if (pieces.length === 0) return [];
    const embeddings = await deps.embed(pieces);
    return sourcesRepo.insertSourceChunks(
      sourceId,
      pieces.map((content, i) => ({ chunkIndex: i, content, embedding: embeddings[i] })),
    );
  }

  async function upsertSource(
    doc: SourceDocument & { tags?: string[]; maxChars?: number },
  ): Promise<UpsertSourceResult> {
    const existing = doc.doi
      ? await sourcesRepo.findSourceByDoi(doc.doi)
      : doc.url
        ? await sourcesRepo.findSourceByUrl(doc.url)
        : null;

    if (existing) {
      let chunks = await sourcesRepo.getSourceChunksBySource(existing.id);
      if (chunks.length === 0 && existing.fullText) {
        chunks = await chunkAndStore(existing.id, existing.fullText);
      }
      return { source: existing, chunks, created: false };
    }

    const source = await sourcesRepo.insertSource({
      sourceType: doc.sourceType,
      title: doc.title,
      url: doc.url,
      doi: doc.doi,
      authors: doc.authors,
      publicationDate: doc.publicationDate,
      fullText: doc.text,
      tags: doc.tags ?? [],
      metadata: { ...doc.metadata, textKind: doc.textKind },
    });

    const budget = doc.maxChars ?? DEFAULT_CHUNKING_BUDGET_CHARS;
    const chunks = await chunkAndStore(source.id, doc.text.slice(0, budget));
    return { source, chunks, created: true };
  }

  async function getSource(id: string): Promise<Source | null> {
    return sourcesRepo.getSourceById(id);
  }

  async function listSources(filters: ListSourcesFilters = {}): Promise<Source[]> {
    return sourcesRepo.listSources(filters);
  }

  async function getSourceChunks(sourceId: string): Promise<SourceChunk[]> {
    return sourcesRepo.getSourceChunksBySource(sourceId);
  }

  async function findSource(query: { doi?: string | null; url?: string | null }): Promise<Source | null> {
    if (query.doi) {
      const byDoi = await sourcesRepo.findSourceByDoi(query.doi);
      if (byDoi) return byDoi;
    }
    if (query.url) {
      return sourcesRepo.findSourceByUrl(query.url);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  async function createTypedNode(
    type: "claim" | "observation" | "hypothesis",
    input: CreateNodeInput,
    defaultOrigin: NodeOrigin,
    restrictOrigin: boolean,
    dedupe: boolean,
  ): Promise<CreateNodeResult> {
    const origin = input.origin ?? defaultOrigin;
    if (restrictOrigin && origin === "agent_generated") {
      throw new Error(`${type} nodes cannot have origin "agent_generated" (allowed: source_derived, operator)`);
    }

    const [embedding] = await deps.embed([input.statement]);

    if (dedupe) {
      const existing = await knowledgeRepo.findSimilarNode(embedding, type, DEDUPE_SIMILARITY_THRESHOLD);
      if (existing) return { node: existing, created: false };
    }

    const node = await knowledgeRepo.insertNode({
      type,
      statement: input.statement,
      summary: input.summary ?? null,
      confidence: input.confidence ?? null,
      status: input.status ?? "unresolved",
      origin,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      embedding,
    });
    await knowledgeRepo.insertNodeHistory({
      nodeId: node.id,
      confidence: node.confidence,
      status: node.status,
      reason: "created",
      runId: input.runId ?? null,
    });
    return { node, created: true };
  }

  async function createClaim(input: CreateNodeInput): Promise<CreateNodeResult> {
    return createTypedNode("claim", input, "source_derived", true, true);
  }

  async function createObservation(input: CreateNodeInput): Promise<CreateNodeResult> {
    return createTypedNode("observation", input, "source_derived", true, false);
  }

  async function createHypothesis(input: CreateNodeInput): Promise<CreateNodeResult> {
    return createTypedNode("hypothesis", input, "agent_generated", false, false);
  }

  async function createInsight(input: CreateInsightInput): Promise<CreateNodeResult> {
    if (!input.derivedFrom || input.derivedFrom.length === 0) {
      throw new Error("createInsight requires at least one derivedFrom node id");
    }
    const sourceNodes = await knowledgeRepo.getNodesByIds(input.derivedFrom);
    const foundIds = new Set(sourceNodes.map((n) => n.id));
    const missing = input.derivedFrom.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`createInsight: unknown derivedFrom node id(s): ${missing.join(", ")}`);
    }

    const [embedding] = await deps.embed([input.statement]);
    const node = await knowledgeRepo.insertNode({
      type: "insight",
      statement: input.statement,
      summary: input.summary ?? null,
      confidence: input.confidence ?? null,
      status: "unresolved",
      origin: "agent_generated",
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      embedding,
    });
    await knowledgeRepo.insertNodeHistory({
      nodeId: node.id,
      confidence: node.confidence,
      status: node.status,
      reason: "created",
      runId: input.runId ?? null,
    });
    for (const fromId of input.derivedFrom) {
      await edgesRepo.upsertEdge({
        fromNodeId: node.id,
        toNodeId: fromId,
        relationshipType: "derived_from",
        confidence: null,
        sourceId: null,
        metadata: {},
      });
    }
    return { node, created: true };
  }

  async function createQuestion(input: CreateQuestionInput): Promise<CreateNodeResult> {
    const [embedding] = await deps.embed([input.statement]);
    const existing = await knowledgeRepo.findSimilarNode(embedding, "question", DEDUPE_SIMILARITY_THRESHOLD);
    if (existing) return { node: existing, created: false };

    const node = await knowledgeRepo.insertNode({
      type: "question",
      statement: input.statement,
      summary: input.summary ?? null,
      confidence: null,
      status: "open",
      origin: input.origin ?? "agent_generated",
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      embedding,
    });
    await knowledgeRepo.insertNodeHistory({
      nodeId: node.id,
      confidence: null,
      status: "open",
      reason: "created",
      runId: input.runId ?? null,
    });
    for (const raisedById of input.raisedBy ?? []) {
      await edgesRepo.upsertEdge({
        fromNodeId: raisedById,
        toNodeId: node.id,
        relationshipType: "raises",
        confidence: null,
        sourceId: null,
        metadata: {},
      });
    }
    return { node, created: true };
  }

  async function getNode(id: string): Promise<KnowledgeNode | null> {
    return knowledgeRepo.getNodeById(id);
  }

  async function listNodes(filters: ListNodesFilters = {}): Promise<KnowledgeNode[]> {
    return knowledgeRepo.listNodes(filters);
  }

  async function updateNodeStatus(
    id: string,
    status: NodeStatus,
    reason: string,
    runId?: string | null,
  ): Promise<KnowledgeNode | null> {
    const updated = await knowledgeRepo.updateNodeStatusOnly(id, status);
    if (!updated) return null;
    await knowledgeRepo.insertNodeHistory({
      nodeId: id,
      confidence: updated.confidence,
      status,
      reason,
      runId: runId ?? null,
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Claim detail
  // -------------------------------------------------------------------------

  async function getClaim(id: string): Promise<ClaimDetail | null> {
    const node = await knowledgeRepo.getNodeById(id);
    if (!node) return null;

    const evidence = await evidenceRepo.getEvidenceWithSourceForNode(id);
    const supporting = evidence.filter((e) => e.evidenceType === "supports" || e.evidenceType === "replicates");
    const contradicting = evidence.filter((e) => e.evidenceType === "contradicts" || e.evidenceType === "challenges");
    const contextual = evidence.filter((e) => e.evidenceType === "contextualizes");

    const [outgoing, incoming, history] = await Promise.all([
      edgesRepo.getOutgoingEdges(id),
      edgesRepo.getIncomingEdges(id),
      knowledgeRepo.getNodeHistory(id),
    ]);

    const related: RelatedNode[] = [
      ...outgoing.map((r) => ({ edge: r.edge, node: r.node, direction: "outgoing" as const })),
      ...incoming.map((r) => ({ edge: r.edge, node: r.node, direction: "incoming" as const })),
    ];

    // "raises" edges point FROM the node that raised the question TO the question.
    const questions = outgoing
      .filter((r) => r.edge.relationshipType === "raises" && r.node.type === "question")
      .map((r) => r.node);

    const sourceIds = Array.from(new Set(evidence.map((e) => e.sourceId)));
    const sources = await sourcesRepo.getSourcesByIds(sourceIds);
    const impactNeighbours = await resolveImpactNeighbours(node);

    return { node, supporting, contradicting, contextual, related, questions, sources, history, impactNeighbours };
  }

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  async function getEvidenceForClaim(id: string): Promise<EvidenceWithSource[]> {
    return evidenceRepo.getEvidenceWithSourceForNode(id, ["supports", "replicates"]);
  }

  async function getEvidenceAgainstClaim(id: string): Promise<EvidenceWithSource[]> {
    return evidenceRepo.getEvidenceWithSourceForNode(id, ["contradicts", "challenges"]);
  }

  async function listEvidence(filters: EvidenceListFilters = {}): Promise<EvidenceListItem[]> {
    return evidenceRepo.listEvidence(filters);
  }

  async function addEvidence(input: AddEvidenceInput): Promise<{ evidence: Evidence; created: boolean }> {
    const node = await knowledgeRepo.getNodeById(input.claimId);
    if (!node) throw new ProvenanceError(`Unknown node: ${input.claimId}`);
    if (!EVIDENCE_TARGETABLE_TYPES.includes(node.type)) {
      throw new ProvenanceError(
        `Evidence cannot target a "${node.type}" node (only claim, hypothesis, observation)`,
      );
    }

    const source = await sourcesRepo.getSourceById(input.sourceId);
    if (!source) throw new ProvenanceError(`Unknown source: ${input.sourceId}`);

    const quote = input.quote.trim();
    if (!quote) throw new ProvenanceError("Evidence quote must be non-empty");

    const chunks = await sourcesRepo.getSourceChunksBySource(input.sourceId);
    const matchingChunk = chunks.find((c) => containsQuote(c.content, quote));
    const verified = matchingChunk !== undefined || containsQuote(source.fullText, quote);
    if (!verified) {
      throw new ProvenanceError(
        "Evidence quote does not appear verbatim in the given chunk, any of the source's chunks, or its full text",
      );
    }

    const sourceChunkId = input.sourceChunkId ?? matchingChunk?.id ?? null;

    const result = await evidenceRepo.insertEvidenceIfNew({
      claimId: input.claimId,
      sourceId: input.sourceId,
      sourceChunkId,
      quote,
      evidenceType: input.evidenceType,
      strength: input.strength ?? "moderate",
      independence: input.independence ?? "unknown",
      notes: input.notes ?? null,
      runId: input.runId ?? null,
    });

    await recomputeConfidence(input.claimId, "evidence added", input.runId ?? null);
    return result;
  }

  // -------------------------------------------------------------------------
  // Graph
  // -------------------------------------------------------------------------

  async function linkKnowledge(input: LinkKnowledgeInput): Promise<KnowledgeEdge> {
    if (input.fromId === input.toId) {
      throw new Error("linkKnowledge: cannot link a node to itself");
    }
    return edgesRepo.upsertEdge({
      fromNodeId: input.fromId,
      toNodeId: input.toId,
      relationshipType: input.relationshipType,
      confidence: input.confidence ?? null,
      sourceId: input.sourceId ?? null,
      metadata: input.metadata ?? {},
    });
  }

  async function findRelatedKnowledge(id: string): Promise<RelatedNode[]> {
    const [outgoing, incoming] = await Promise.all([edgesRepo.getOutgoingEdges(id), edgesRepo.getIncomingEdges(id)]);
    return [
      ...outgoing.map((r) => ({ edge: r.edge, node: r.node, direction: "outgoing" as const })),
      ...incoming.map((r) => ({ edge: r.edge, node: r.node, direction: "incoming" as const })),
    ];
  }

  // -------------------------------------------------------------------------
  // Confidence
  // -------------------------------------------------------------------------

  async function updateConfidence(id: string, input: UpdateConfidenceInput): Promise<KnowledgeNode | null> {
    const updated = await knowledgeRepo.updateNodeConfidenceStatus(id, {
      confidence: input.confidence,
      status: input.status,
    });
    if (!updated) return null;
    await knowledgeRepo.insertNodeHistory({
      nodeId: id,
      confidence: input.confidence,
      status: input.status,
      reason: input.reason,
      runId: input.runId ?? null,
    });
    return updated;
  }

  async function recomputeConfidence(
    id: string,
    reason: string,
    runId?: string | null,
  ): Promise<KnowledgeNode | null> {
    const node = await knowledgeRepo.getNodeById(id);
    if (!node) return null;
    if (node.type === "question" || node.type === "insight") return node;
    if (node.status === "superseded") return node;

    const evidence = await evidenceRepo.getEvidenceForNode(id);
    const { confidence, status } = computeConfidence(evidence);

    if (confidenceEquals(confidence, node.confidence) && status === node.status) return node;

    return updateConfidence(id, { confidence, status, reason, runId: runId ?? null });
  }

  // -------------------------------------------------------------------------
  // Impact
  // -------------------------------------------------------------------------

  /**
   * How many nearest neighbours to consider per node, and how similar they must
   * be to count at all. Kept in step with `match_neighbour_nodes`'s defaults.
   */
  const IMPACT_VECTOR_NEIGHBOURS = 8;
  const IMPACT_MIN_SIMILARITY = 0.75;
  /** Ceiling on one recompute pass, so a large run cannot fan out unboundedly. */
  const IMPACT_MAX_NODES = 200;

  /**
   * Gathers every node's neighbours in a fixed number of queries (not one per
   * node) and scores them. Impact depends on the neighbourhood, so unlike
   * `recomputeConfidence` this is deliberately batch-shaped.
   */
  async function scoreNodes(ids: string[]): Promise<Map<string, ImpactResult>> {
    const results = new Map<string, ImpactResult>();
    if (ids.length === 0) return results;

    const [edges, vectors] = await Promise.all([
      edgesRepo.getNeighbourEdgesForNodes(ids),
      knowledgeRepo.getVectorNeighboursForNodes(ids, IMPACT_VECTOR_NEIGHBOURS, IMPACT_MIN_SIMILARITY),
    ]);

    // One lookup covering the scored nodes and everything they touch.
    const neighbourIds = new Set<string>();
    for (const e of edges) neighbourIds.add(e.neighbour_id);
    for (const v of vectors) neighbourIds.add(v.neighbour_id);
    const inputs = await knowledgeRepo.getImpactInputsForNodes([...new Set([...ids, ...neighbourIds])]);
    const byId = new Map(inputs.map((row) => [row.id, row]));

    const linksByNode = new Map<string, { neighbourId: string; link: ImpactLink }[]>();
    const push = (nodeId: string, neighbourId: string, link: ImpactLink) => {
      const list = linksByNode.get(nodeId) ?? [];
      list.push({ neighbourId, link });
      linksByNode.set(nodeId, list);
    };
    for (const e of edges) {
      push(e.node_id, e.neighbour_id, { kind: "edge", relationshipType: e.relationship_type, direction: e.direction });
    }
    for (const v of vectors) {
      push(v.node_id, v.neighbour_id, { kind: "similar", similarity: v.similarity });
    }

    for (const id of ids) {
      const self = byId.get(id);
      if (!self) continue;
      const neighbours: ImpactNeighbour[] = [];
      for (const { neighbourId, link } of linksByNode.get(id) ?? []) {
        const row = byId.get(neighbourId);
        if (!row) continue;
        neighbours.push({
          nodeId: row.id,
          statement: row.statement,
          type: row.type,
          status: row.status,
          confidence: row.confidence,
          distinctSourceCount: row.distinct_source_count,
          link,
        });
      }
      results.set(
        id,
        computeImpact(
          {
            status: self.status,
            confidence: self.confidence,
            distinctSourceCount: self.distinct_source_count,
            hasEmbedding: self.has_embedding,
          },
          neighbours,
        ),
      );
    }
    return results;
  }

  /**
   * Resolves the neighbours behind a node's stored impact score, so the detail
   * page can name which findings would move rather than just showing a number.
   * Recomputes the links live (cheap: two queries) so the list matches the
   * current graph even when the stored score is a little stale.
   */
  async function resolveImpactNeighbours(node: KnowledgeNode): Promise<ImpactNeighbourDetail[]> {
    const scored = await scoreNodes([node.id]);
    const result = scored.get(node.id);
    if (!result || result.components.edgeNeighbours + result.components.similarNeighbours === 0) return [];

    const [edges, vectors] = await Promise.all([
      edgesRepo.getNeighbourEdgesForNodes([node.id]),
      knowledgeRepo.getVectorNeighboursForNodes([node.id], IMPACT_VECTOR_NEIGHBOURS, IMPACT_MIN_SIMILARITY),
    ]);
    const links = new Map<string, ImpactLink>();
    // Edges last so an explicit relationship wins over a latent one, matching
    // how computeImpact picks the strongest link per neighbour.
    for (const v of vectors) links.set(v.neighbour_id, { kind: "similar", similarity: v.similarity });
    for (const e of edges) {
      links.set(e.neighbour_id, { kind: "edge", relationshipType: e.relationship_type, direction: e.direction });
    }
    if (links.size === 0) return [];

    const nodes = await knowledgeRepo.getNodesByIds([...links.keys()]);
    const inputs = await knowledgeRepo.getImpactInputsForNodes([...links.keys()]);
    const stats = new Map(inputs.map((row) => [row.id, row]));

    return nodes
      .map((neighbour) => {
        const link = links.get(neighbour.id)!;
        const row = stats.get(neighbour.id);
        const gain = row
          ? linkCoupling(link) *
            headroomOf({ status: row.status, confidence: row.confidence, distinctSourceCount: row.distinct_source_count })
          : 0;
        return { node: neighbour, link, gain: Math.round(gain * 1000) / 1000 };
      })
      .filter((n) => n.gain > 0)
      .sort((a, b) => b.gain - a.gain);
  }

  /**
   * Recomputes impact for `ids`, optionally for their 1-hop neighbours too.
   *
   * The 1-hop closure is the correct staleness boundary: changing a node's
   * status changes the reach of everything pointing at it, but not of nodes two
   * hops away, whose contribution is mediated by a neighbour that did not move.
   */
  async function recomputeImpact(ids: string[], opts: { includeNeighbours?: boolean } = {}): Promise<number> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return 0;

    let targets = unique;
    if (opts.includeNeighbours) {
      const [edges, vectors] = await Promise.all([
        edgesRepo.getNeighbourEdgesForNodes(unique),
        knowledgeRepo.getVectorNeighboursForNodes(unique, IMPACT_VECTOR_NEIGHBOURS, IMPACT_MIN_SIMILARITY),
      ]);
      const frontier = new Set(unique);
      for (const e of edges) frontier.add(e.neighbour_id);
      for (const v of vectors) frontier.add(v.neighbour_id);
      targets = [...frontier];
    }
    targets = targets.slice(0, IMPACT_MAX_NODES);

    const scored = await scoreNodes(targets);
    return knowledgeRepo.updateNodeImpactBatch(
      [...scored.entries()].map(([id, result]) => ({
        id,
        impact: result.impact,
        explanation: { components: result.components, reasons: result.reasons },
      })),
    );
  }

  /** Full refresh, stalest first, for the maintenance button. */
  async function recomputeAllImpact(limit = 500): Promise<number> {
    const ids = await knowledgeRepo.getNodeIdsForImpactRefresh(limit);
    const scored = await scoreNodes(ids);
    return knowledgeRepo.updateNodeImpactBatch(
      [...scored.entries()].map(([id, result]) => ({
        id,
        impact: result.impact,
        explanation: { components: result.components, reasons: result.reasons },
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Drill-down queue
  // -------------------------------------------------------------------------

  async function requestDrillDown(id: string, note?: string | null): Promise<KnowledgeNode | null> {
    // Re-queueing something already pending is a note edit, not a new entry, so
    // it must not count against the cap.
    const existing = await knowledgeRepo.getNodeById(id);
    const alreadyPending = existing?.drillDownRequestedAt !== null && existing?.drillDownConsumedAt === null;
    if (!alreadyPending && (await knowledgeRepo.countPendingDrillDown()) >= MAX_DRILL_DOWN_QUEUE) {
      throw new DrillDownQueueFullError();
    }
    return knowledgeRepo.setDrillDownRequest(id, note?.trim() || null);
  }

  async function reorderDrillDownQueue(ids: string[]): Promise<void> {
    return knowledgeRepo.reorderDrillDownQueue(ids);
  }

  async function cancelDrillDown(id: string): Promise<KnowledgeNode | null> {
    return knowledgeRepo.clearDrillDownRequest(id);
  }

  async function listDrillDownQueue(limit = 5): Promise<KnowledgeNode[]> {
    return knowledgeRepo.listDrillDownQueue(limit);
  }

  async function markDrillDownConsumed(ids: string[]): Promise<void> {
    return knowledgeRepo.markDrillDownConsumed(ids);
  }

  // -------------------------------------------------------------------------
  // Retrieval
  // -------------------------------------------------------------------------

  async function searchKnowledge(query: string, filters: RetrievalFilters = {}): Promise<KnowledgeContext> {
    return searchKnowledgeImpl(deps, query, filters);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async function backfillEmbeddings(limit = 100): Promise<{ nodes: number; chunks: number }> {
    const nodes = await knowledgeRepo.getNodesWithNullEmbedding(limit);
    if (nodes.length > 0) {
      const embeddings = await deps.embed(nodes.map((n) => n.statement));
      await Promise.all(nodes.map((n, i) => knowledgeRepo.updateNodeEmbedding(n.id, embeddings[i])));
    }

    const chunks = await sourcesRepo.getChunksWithNullEmbedding(limit);
    if (chunks.length > 0) {
      const embeddings = await deps.embed(chunks.map((c) => c.content));
      await Promise.all(chunks.map((c, i) => sourcesRepo.updateChunkEmbedding(c.id, embeddings[i])));
    }

    return { nodes: nodes.length, chunks: chunks.length };
  }

  async function stats(): Promise<KnowledgeStats> {
    const [byType, byStatus, sourceCount, evidenceCount, edgeCount] = await Promise.all([
      knowledgeRepo.countNodesByType(),
      knowledgeRepo.countNodesByStatus(),
      sourcesRepo.countSources(),
      evidenceRepo.countEvidence(),
      edgesRepo.countEdges(),
    ]);
    const nodesByType = Object.fromEntries(NODE_TYPES.map((t) => [t, byType[t] ?? 0])) as Record<NodeType, number>;
    return { nodesByType, nodesByStatus: byStatus, sources: sourceCount, evidence: evidenceCount, edges: edgeCount };
  }

  return {
    upsertSource,
    getSource,
    listSources,
    getSourceChunks,
    findSource,
    createClaim,
    createObservation,
    createHypothesis,
    createInsight,
    createQuestion,
    getNode,
    listNodes,
    updateNodeStatus,
    getClaim,
    getEvidenceForClaim,
    getEvidenceAgainstClaim,
    listEvidence,
    addEvidence,
    linkKnowledge,
    findRelatedKnowledge,
    updateConfidence,
    recomputeConfidence,
    recomputeImpact,
    recomputeAllImpact,
    requestDrillDown,
    reorderDrillDownQueue,
    cancelDrillDown,
    listDrillDownQueue,
    markDrillDownConsumed,
    searchKnowledge,
    backfillEmbeddings,
    stats,
  };
}
