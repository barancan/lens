import { db } from "@/lib/db/client";
import type { KnowledgeEdge, KnowledgeNode, RelationshipType } from "@/lib/types";
import { mapNode, NODE_COLUMN_NAMES, type NodeRow } from "./knowledge";

/**
 * Plain SQL access to `knowledge_edges`. No business rules beyond the SQL
 * itself — self-link rejection etc. live in `src/lib/knowledge/service.ts`.
 */

interface EdgeRow {
  id: string;
  from_node_id: string;
  to_node_id: string;
  relationship_type: RelationshipType;
  confidence: number | null;
  source_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function mapEdge(row: EdgeRow): KnowledgeEdge {
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    relationshipType: row.relationship_type,
    confidence: row.confidence,
    sourceId: row.source_id,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}


export interface UpsertEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  relationshipType: RelationshipType;
  confidence: number | null;
  sourceId: string | null;
  metadata: Record<string, unknown>;
}

/** Idempotent upsert keyed on (from_node_id, to_node_id, relationship_type). */
export async function upsertEdge(input: UpsertEdgeInput): Promise<KnowledgeEdge> {
  const sql = db();
  const rows = await sql<EdgeRow[]>`
    insert into knowledge_edges (from_node_id, to_node_id, relationship_type, confidence, source_id, metadata)
    values (
      ${input.fromNodeId}, ${input.toNodeId}, ${input.relationshipType}, ${input.confidence}, ${input.sourceId},
      ${sql.json(input.metadata as never)}
    )
    on conflict (from_node_id, to_node_id, relationship_type)
    do update set confidence = excluded.confidence, source_id = excluded.source_id, metadata = excluded.metadata
    returning id, from_node_id, to_node_id, relationship_type, confidence, source_id, metadata, created_at
  `;
  return mapEdge(rows[0]);
}

export interface EdgeWithNode {
  edge: KnowledgeEdge;
  node: KnowledgeNode;
}

/** The joined node's columns, prefixed to avoid colliding with the edge's own. */
type EdgeNodeRow = EdgeRow & Record<`n_${string}`, unknown>;

function mapEdgeNodeRow(row: EdgeNodeRow): EdgeWithNode {
  const node = Object.fromEntries(
    NODE_COLUMN_NAMES.map((column) => [column, row[`n_${column}`]]),
  ) as unknown as NodeRow;
  return { edge: mapEdge(row), node: mapNode(node) };
}

/**
 * Built from NODE_COLUMN_NAMES rather than spelled out, so a new node column
 * reaches this join automatically. Written by hand it would silently return
 * `undefined` for anything forgotten.
 */
const EDGE_NODE_SELECT = [
  "e.id, e.from_node_id, e.to_node_id, e.relationship_type, e.confidence, e.source_id, e.metadata, e.created_at",
  ...NODE_COLUMN_NAMES.map((column) => `n.${column} as n_${column}`),
].join(", ");

/** Edges where `nodeId` is the source; `node` is the other end (the "to" node). */
export async function getOutgoingEdges(nodeId: string): Promise<EdgeWithNode[]> {
  const sql = db();
  const rows = await sql<EdgeNodeRow[]>`
    select ${sql.unsafe(EDGE_NODE_SELECT)}
    from knowledge_edges e
    join knowledge_nodes n on n.id = e.to_node_id
    where e.from_node_id = ${nodeId}
    order by e.created_at asc
  `;
  return rows.map(mapEdgeNodeRow);
}

/** Edges where `nodeId` is the target; `node` is the other end (the "from" node). */
export async function getIncomingEdges(nodeId: string): Promise<EdgeWithNode[]> {
  const sql = db();
  const rows = await sql<EdgeNodeRow[]>`
    select ${sql.unsafe(EDGE_NODE_SELECT)}
    from knowledge_edges e
    join knowledge_nodes n on n.id = e.from_node_id
    where e.to_node_id = ${nodeId}
    order by e.created_at asc
  `;
  return rows.map(mapEdgeNodeRow);
}

export async function countEdges(): Promise<number> {
  const sql = db();
  const rows = await sql<{ count: string }[]>`select count(*)::text as count from knowledge_edges`;
  return Number(rows[0]?.count ?? 0);
}

/** A node's edge neighbours, from that node's point of view. */
export interface NeighbourEdgeRow {
  node_id: string;
  neighbour_id: string;
  relationship_type: RelationshipType;
  direction: "incoming" | "outgoing";
}

/**
 * Both directions for many nodes in a single query, for impact scoring.
 * Index coverage is already there: the unique (from, to, type) constraint
 * serves the first arm and `knowledge_edges_to_idx` the second.
 */
export async function getNeighbourEdgesForNodes(ids: string[]): Promise<NeighbourEdgeRow[]> {
  if (ids.length === 0) return [];
  const sql = db();
  return sql<NeighbourEdgeRow[]>`
    select from_node_id as node_id, to_node_id as neighbour_id, relationship_type, 'outgoing' as direction
      from knowledge_edges where from_node_id = any(${ids}::uuid[])
    union all
    select to_node_id as node_id, from_node_id as neighbour_id, relationship_type, 'incoming' as direction
      from knowledge_edges where to_node_id = any(${ids}::uuid[])
  `;
}
