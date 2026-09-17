import { db, toVector } from "@/lib/db/client";
import type {
  ImpactExplanation,
  KnowledgeNode,
  NodeHistoryEntry,
  NodeOrigin,
  NodeStatus,
  NodeType,
} from "@/lib/types";

/**
 * Plain SQL access to `knowledge_nodes` and `knowledge_node_history`. No
 * business rules beyond the SQL itself — dedupe, origin restrictions,
 * confidence heuristics, etc. live in `src/lib/knowledge/service.ts`.
 */

interface NodeRow {
  id: string;
  type: NodeType;
  statement: string;
  summary: string | null;
  confidence: number | null;
  status: NodeStatus;
  origin: NodeOrigin;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  impact: number | null;
  impact_explanation: ImpactExplanation | null;
  impact_computed_at: Date | null;
  drill_down_requested_at: Date | null;
  drill_down_note: string | null;
  drill_down_consumed_at: Date | null;
  drill_down_position: number | null;
}

/**
 * Every column of `knowledge_nodes` the app maps, minus the embedding vector
 * (which is large and never leaves the database). Selects are built from this
 * single list so adding a column cannot silently leave one query behind —
 * `mapNode` would just yield `undefined` for it, with no error.
 */
export const NODE_COLUMN_NAMES = [
  "id",
  "type",
  "statement",
  "summary",
  "confidence",
  "status",
  "origin",
  "tags",
  "metadata",
  "created_at",
  "updated_at",
  "impact",
  "impact_explanation",
  "impact_computed_at",
  "drill_down_requested_at",
  "drill_down_note",
  "drill_down_consumed_at",
  "drill_down_position",
] as const;

export const NODE_COLUMNS = NODE_COLUMN_NAMES.join(", ");

interface HistoryRow {
  id: string;
  node_id: string;
  confidence: number | null;
  status: NodeStatus;
  reason: string;
  run_id: string | null;
  created_at: Date;
}

export function mapNode(row: NodeRow): KnowledgeNode {
  return {
    id: row.id,
    type: row.type,
    statement: row.statement,
    summary: row.summary,
    confidence: row.confidence,
    status: row.status,
    origin: row.origin,
    tags: row.tags,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    impact: row.impact,
    impactExplanation: row.impact_explanation,
    impactComputedAt: row.impact_computed_at?.toISOString() ?? null,
    drillDownRequestedAt: row.drill_down_requested_at?.toISOString() ?? null,
    drillDownNote: row.drill_down_note,
    drillDownConsumedAt: row.drill_down_consumed_at?.toISOString() ?? null,
    drillDownPosition: row.drill_down_position,
  };
}

export type { NodeRow };

function mapHistory(row: HistoryRow): NodeHistoryEntry {
  return {
    id: row.id,
    nodeId: row.node_id,
    confidence: row.confidence,
    status: row.status,
    reason: row.reason,
    runId: row.run_id,
    createdAt: row.created_at.toISOString(),
  };
}

export interface InsertNodeInput {
  type: NodeType;
  statement: string;
  summary: string | null;
  confidence: number | null;
  status: NodeStatus;
  origin: NodeOrigin;
  tags: string[];
  metadata: Record<string, unknown>;
  embedding: number[] | null;
}

export async function insertNode(input: InsertNodeInput): Promise<KnowledgeNode> {
  const sql = db();
  const rows = await sql<NodeRow[]>`
    insert into knowledge_nodes (type, statement, summary, confidence, status, origin, tags, metadata, embedding)
    values (
      ${input.type}, ${input.statement}, ${input.summary}, ${input.confidence}, ${input.status}, ${input.origin},
      ${input.tags}::text[], ${sql.json(input.metadata as never)}, ${toVector(input.embedding)}::vector
    )
    returning ${sql.unsafe(NODE_COLUMNS)}
  `;
  return mapNode(rows[0]);
}

export async function getNodeById(id: string): Promise<KnowledgeNode | null> {
  const sql = db();
  const rows = await sql<NodeRow[]>`
    select ${sql.unsafe(NODE_COLUMNS)}
    from knowledge_nodes where id = ${id}
  `;
  return rows[0] ? mapNode(rows[0]) : null;
}

export async function getNodesByIds(ids: string[]): Promise<KnowledgeNode[]> {
  if (ids.length === 0) return [];
  const sql = db();
  const rows = await sql<NodeRow[]>`
    select ${sql.unsafe(NODE_COLUMNS)}
    from knowledge_nodes where id = any(${ids}::uuid[])
  `;
  return rows.map(mapNode);
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

export async function listNodes(filters: ListNodesFilters = {}): Promise<KnowledgeNode[]> {
  const sql = db();
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const rows = await sql<NodeRow[]>`
    select ${sql.unsafe(NODE_COLUMNS)}
    from knowledge_nodes
    where 1=1
      ${filters.types?.length ? sql`and type = any(${filters.types}::text[])` : sql``}
      ${filters.statuses?.length ? sql`and status = any(${filters.statuses}::text[])` : sql``}
      ${filters.origins?.length ? sql`and origin = any(${filters.origins}::text[])` : sql``}
      ${filters.tags?.length ? sql`and tags && ${filters.tags}::text[]` : sql``}
      ${filters.minConfidence != null ? sql`and confidence >= ${filters.minConfidence}` : sql``}
      ${filters.minImpact != null ? sql`and impact >= ${filters.minImpact}` : sql``}
      ${filters.text ? sql`and (statement ilike ${"%" + filters.text + "%"} or summary ilike ${"%" + filters.text + "%"})` : sql``}
    ${filters.orderBy === "impact" ? sql`order by impact desc nulls last, created_at desc` : sql`order by created_at desc`}
    limit ${limit} offset ${offset}
  `;
  return rows.map(mapNode);
}

export async function updateNodeStatusOnly(id: string, status: NodeStatus): Promise<KnowledgeNode | null> {
  const sql = db();
  const rows = await sql<NodeRow[]>`
    update knowledge_nodes set status = ${status}, updated_at = now() where id = ${id}
    returning ${sql.unsafe(NODE_COLUMNS)}
  `;
  return rows[0] ? mapNode(rows[0]) : null;
}

export async function updateNodeConfidenceStatus(
  id: string,
  patch: { confidence: number | null; status: NodeStatus },
): Promise<KnowledgeNode | null> {
  const sql = db();
  const rows = await sql<NodeRow[]>`
    update knowledge_nodes set confidence = ${patch.confidence}, status = ${patch.status}, updated_at = now()
    where id = ${id}
    returning ${sql.unsafe(NODE_COLUMNS)}
  `;
  return rows[0] ? mapNode(rows[0]) : null;
}

export async function updateNodeEmbedding(id: string, embedding: number[]): Promise<void> {
  const sql = db();
  await sql`update knowledge_nodes set embedding = ${toVector(embedding)}::vector where id = ${id}`;
}

export async function getNodesWithNullEmbedding(limit: number): Promise<{ id: string; statement: string }[]> {
  const sql = db();
  const rows = await sql<{ id: string; statement: string }[]>`
    select id, statement from knowledge_nodes where embedding is null order by created_at asc limit ${limit}
  `;
  return rows;
}

/** Nearest node of `type` by embedding cosine similarity, if within `threshold`. Used for dedupe. */
export async function findSimilarNode(
  embedding: number[],
  type: NodeType,
  threshold: number,
): Promise<KnowledgeNode | null> {
  const sql = db();
  const rows = await sql<(NodeRow & { similarity: number })[]>`
    select ${sql.unsafe(NODE_COLUMNS)},
      1 - (embedding <=> ${toVector(embedding)}::vector) as similarity
    from knowledge_nodes
    where type = ${type} and embedding is not null
    order by embedding <=> ${toVector(embedding)}::vector
    limit 1
  `;
  const row = rows[0];
  if (!row || row.similarity < threshold) return null;
  return mapNode(row);
}

export interface MatchNodesFilters {
  types?: NodeType[];
  minConfidence?: number;
  tags?: string[];
}

/** Wraps the `match_knowledge_nodes` SQL function. */
export async function matchKnowledgeNodesByVector(
  embedding: number[],
  matchCount: number,
  filters: MatchNodesFilters = {},
): Promise<{ id: string; similarity: number }[]> {
  const sql = db();
  const rows = await sql<{ id: string; similarity: number }[]>`
    select id, similarity from match_knowledge_nodes(
      ${toVector(embedding)}::vector,
      ${matchCount},
      ${filters.types?.length ? filters.types : null}::text[],
      ${filters.minConfidence ?? null},
      ${filters.tags?.length ? filters.tags : null}::text[]
    )
  `;
  return rows;
}

/** Full-text keyword search over statement + summary. */
export async function keywordSearchNodes(
  query: string,
  matchCount: number,
  filters: MatchNodesFilters = {},
): Promise<{ id: string }[]> {
  const sql = db();
  const rows = await sql<{ id: string }[]>`
    select id from knowledge_nodes
    where to_tsvector('english', statement || ' ' || coalesce(summary, '')) @@ websearch_to_tsquery('english', ${query})
      ${filters.types?.length ? sql`and type = any(${filters.types}::text[])` : sql``}
      ${filters.minConfidence != null ? sql`and confidence >= ${filters.minConfidence}` : sql``}
      ${filters.tags?.length ? sql`and tags && ${filters.tags}::text[]` : sql``}
    limit ${matchCount}
  `;
  return rows;
}

export async function insertNodeHistory(entry: {
  nodeId: string;
  confidence: number | null;
  status: NodeStatus;
  reason: string;
  runId?: string | null;
}): Promise<NodeHistoryEntry> {
  const sql = db();
  const rows = await sql<HistoryRow[]>`
    insert into knowledge_node_history (node_id, confidence, status, reason, run_id)
    values (${entry.nodeId}, ${entry.confidence}, ${entry.status}, ${entry.reason}, ${entry.runId ?? null})
    returning id, node_id, confidence, status, reason, run_id, created_at
  `;
  return mapHistory(rows[0]);
}

export async function getNodeHistory(nodeId: string): Promise<NodeHistoryEntry[]> {
  const sql = db();
  const rows = await sql<HistoryRow[]>`
    select id, node_id, confidence, status, reason, run_id, created_at
    from knowledge_node_history where node_id = ${nodeId} order by created_at asc
  `;
  return rows.map(mapHistory);
}

export async function countNodesByType(): Promise<Record<string, number>> {
  const sql = db();
  const rows = await sql<{ type: string; count: string }[]>`
    select type, count(*)::text as count from knowledge_nodes group by type
  `;
  return Object.fromEntries(rows.map((r) => [r.type, Number(r.count)]));
}

export async function countNodesByStatus(): Promise<Record<string, number>> {
  const sql = db();
  const rows = await sql<{ status: string; count: string }[]>`
    select status, count(*)::text as count from knowledge_nodes group by status
  `;
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
}

// ---------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------

/**
 * The inputs `computeImpact` needs about a node, for many nodes at once.
 * `has_embedding` is derived in SQL so the 1536-dim vector never crosses the
 * wire, and the distinct source count comes from a single grouped join.
 */
export interface ImpactNodeRow {
  id: string;
  type: NodeType;
  status: NodeStatus;
  confidence: number | null;
  statement: string;
  has_embedding: boolean;
  distinct_source_count: number;
}

export async function getImpactInputsForNodes(ids: string[]): Promise<ImpactNodeRow[]> {
  if (ids.length === 0) return [];
  const sql = db();
  return sql<ImpactNodeRow[]>`
    select
      n.id, n.type, n.status, n.confidence, n.statement,
      n.embedding is not null as has_embedding,
      coalesce(count(distinct e.source_id), 0)::int as distinct_source_count
    from knowledge_nodes n
    left join evidence e on e.claim_id = n.id
    where n.id = any(${ids}::uuid[])
    group by n.id
  `;
}

export interface VectorNeighbourRow {
  node_id: string;
  neighbour_id: string;
  similarity: number;
}

/** Wraps `match_neighbour_nodes`: each node's nearest neighbours, in one call. */
export async function getVectorNeighboursForNodes(
  ids: string[],
  matchCount: number,
  minSimilarity: number,
): Promise<VectorNeighbourRow[]> {
  if (ids.length === 0) return [];
  const sql = db();
  return sql<VectorNeighbourRow[]>`
    select node_id, neighbour_id, similarity
    from match_neighbour_nodes(${ids}::uuid[], ${matchCount}, ${minSimilarity})
  `;
}

/**
 * Writes impact for many nodes in one statement.
 *
 * Deliberately does NOT touch `updated_at`: impact is recomputed for every
 * neighbour of every node a run touches, and the Knowledge table's "Updated"
 * column means "the epistemic content changed". Bumping it here would turn
 * that column into noise. `impact_computed_at` records freshness instead.
 */
export async function updateNodeImpactBatch(
  rows: { id: string; impact: number | null; explanation: ImpactExplanation }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = db();
  // One JSON document expanded server-side, rather than parallel arrays: an
  // array of jsonb bound through the driver double-encodes each element, so the
  // explanation lands as a JSON string scalar instead of an object.
  const result = await sql`
    update knowledge_nodes n
    set impact = v.impact, impact_explanation = v.explanation, impact_computed_at = now()
    from jsonb_to_recordset(${sql.json(rows as never)}::jsonb)
      as v(id uuid, impact real, explanation jsonb)
    where n.id = v.id
  `;
  return result.count;
}

/** Nodes with the oldest impact scores first, for the maintenance recompute. */
export async function getNodeIdsForImpactRefresh(limit: number): Promise<string[]> {
  const sql = db();
  const rows = await sql<{ id: string }[]>`
    select id from knowledge_nodes
    order by impact_computed_at asc nulls first
    limit ${limit}
  `;
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Drill-down queue
// ---------------------------------------------------------------------------

/** Pending (queued, not yet picked up by a run) requests. */
export async function countPendingDrillDown(): Promise<number> {
  const sql = db();
  const rows = await sql<{ c: number }[]>`
    select count(*)::int as c from knowledge_nodes
    where drill_down_requested_at is not null and drill_down_consumed_at is null
  `;
  return rows[0].c;
}

export async function setDrillDownRequest(id: string, note: string | null): Promise<KnowledgeNode | null> {
  const sql = db();
  // Append to the end of the queue; the operator reorders by dragging.
  const rows = await sql<NodeRow[]>`
    update knowledge_nodes
    set drill_down_requested_at = now(),
        drill_down_note = ${note},
        drill_down_consumed_at = null,
        drill_down_position = coalesce(
          (select max(drill_down_position) + 1 from knowledge_nodes
           where drill_down_requested_at is not null and drill_down_consumed_at is null and id <> ${id}),
          1
        )
    where id = ${id}
    returning ${sql.unsafe(NODE_COLUMNS)}
  `;
  return rows[0] ? mapNode(rows[0]) : null;
}

/** Rewrites queue positions to the given order. Ids not in the queue are ignored. */
export async function reorderDrillDownQueue(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const sql = db();
  await sql`
    update knowledge_nodes n
    set drill_down_position = v.position
    from jsonb_to_recordset(${sql.json(ids.map((id, i) => ({ id, position: i + 1 })) as never)}::jsonb)
      as v(id uuid, position int)
    where n.id = v.id
      and n.drill_down_requested_at is not null
      and n.drill_down_consumed_at is null
  `;
}

export async function clearDrillDownRequest(id: string): Promise<KnowledgeNode | null> {
  const sql = db();
  const rows = await sql<NodeRow[]>`
    update knowledge_nodes
    set drill_down_requested_at = null, drill_down_note = null, drill_down_consumed_at = null, drill_down_position = null
    where id = ${id}
    returning ${sql.unsafe(NODE_COLUMNS)}
  `;
  return rows[0] ? mapNode(rows[0]) : null;
}

/** Pending requests only, in the operator's chosen order. */
export async function listDrillDownQueue(limit: number): Promise<KnowledgeNode[]> {
  const sql = db();
  const rows = await sql<NodeRow[]>`
    select ${sql.unsafe(NODE_COLUMNS)}
    from knowledge_nodes
    where drill_down_requested_at is not null and drill_down_consumed_at is null
    order by drill_down_position asc nulls last, drill_down_requested_at asc
    limit ${limit}
  `;
  return rows.map(mapNode);
}

/**
 * Marks requests as picked up by a run. The request itself is kept so the
 * operator can still see it was asked for and when it was actioned.
 */
export async function markDrillDownConsumed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const sql = db();
  await sql`
    update knowledge_nodes set drill_down_consumed_at = now()
    where id = any(${ids}::uuid[]) and drill_down_consumed_at is null
  `;
}
