import { db } from "@/lib/db/client";
import type { KnowledgeEdge, KnowledgeNode, NodeOrigin, NodeStatus, NodeType, RelationshipType } from "@/lib/types";

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

interface EdgeNodeRow extends EdgeRow {
  n_id: string;
  n_type: NodeType;
  n_statement: string;
  n_summary: string | null;
  n_confidence: number | null;
  n_status: NodeStatus;
  n_origin: NodeOrigin;
  n_tags: string[];
  n_metadata: Record<string, unknown>;
  n_created_at: Date;
  n_updated_at: Date;
}

function mapEdgeNodeRow(row: EdgeNodeRow): EdgeWithNode {
  return {
    edge: mapEdge(row),
    node: mapNode({
      id: row.n_id,
      type: row.n_type,
      statement: row.n_statement,
      summary: row.n_summary,
      confidence: row.n_confidence,
      status: row.n_status,
      origin: row.n_origin,
      tags: row.n_tags,
      metadata: row.n_metadata,
      created_at: row.n_created_at,
      updated_at: row.n_updated_at,
    }),
  };
}

const EDGE_NODE_SELECT = `
  e.id, e.from_node_id, e.to_node_id, e.relationship_type, e.confidence, e.source_id, e.metadata, e.created_at,
  n.id as n_id, n.type as n_type, n.statement as n_statement, n.summary as n_summary, n.confidence as n_confidence,
  n.status as n_status, n.origin as n_origin, n.tags as n_tags, n.metadata as n_metadata,
  n.created_at as n_created_at, n.updated_at as n_updated_at
`;

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
