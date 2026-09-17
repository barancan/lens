import { db, toVector } from "@/lib/db/client";
import type { KnowledgeNode, NodeHistoryEntry, NodeOrigin, NodeStatus, NodeType } from "@/lib/types";

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
}

interface HistoryRow {
  id: string;
  node_id: string;
  confidence: number | null;
  status: NodeStatus;
  reason: string;
  run_id: string | null;
  created_at: Date;
}

function mapNode(row: NodeRow): KnowledgeNode {
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
  };
}

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
    returning id, type, statement, summary, confidence, status, origin, tags, metadata, created_at, updated_at
  `;
  return mapNode(rows[0]);
}

export async function getNodeById(id: string): Promise<KnowledgeNode | null> {
  const sql = db();
  const rows = await sql<NodeRow[]>`
    select id, type, statement, summary, confidence, status, origin, tags, metadata, created_at, updated_at
    from knowledge_nodes where id = ${id}
  `;
  return rows[0] ? mapNode(rows[0]) : null;
}

export async function getNodesByIds(ids: string[]): Promise<KnowledgeNode[]> {
  if (ids.length === 0) return [];
  const sql = db();
  const rows = await sql<NodeRow[]>`
    select id, type, statement, summary, confidence, status, origin, tags, metadata, created_at, updated_at
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
  text?: string;
  limit?: number;
  offset?: number;
}

export async function listNodes(filters: ListNodesFilters = {}): Promise<KnowledgeNode[]> {
  const sql = db();
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const rows = await sql<NodeRow[]>`
    select id, type, statement, summary, confidence, status, origin, tags, metadata, created_at, updated_at
    from knowledge_nodes
    where 1=1
      ${filters.types?.length ? sql`and type = any(${filters.types}::text[])` : sql``}
      ${filters.statuses?.length ? sql`and status = any(${filters.statuses}::text[])` : sql``}
      ${filters.origins?.length ? sql`and origin = any(${filters.origins}::text[])` : sql``}
      ${filters.tags?.length ? sql`and tags && ${filters.tags}::text[]` : sql``}
      ${filters.minConfidence != null ? sql`and confidence >= ${filters.minConfidence}` : sql``}
      ${filters.text ? sql`and (statement ilike ${"%" + filters.text + "%"} or summary ilike ${"%" + filters.text + "%"})` : sql``}
    order by created_at desc
    limit ${limit} offset ${offset}
  `;
  return rows.map(mapNode);
}

export async function updateNodeStatusOnly(id: string, status: NodeStatus): Promise<KnowledgeNode | null> {
  const sql = db();
  const rows = await sql<NodeRow[]>`
    update knowledge_nodes set status = ${status}, updated_at = now() where id = ${id}
    returning id, type, statement, summary, confidence, status, origin, tags, metadata, created_at, updated_at
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
    returning id, type, statement, summary, confidence, status, origin, tags, metadata, created_at, updated_at
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
    select id, type, statement, summary, confidence, status, origin, tags, metadata, created_at, updated_at,
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
