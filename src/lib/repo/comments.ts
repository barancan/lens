import { db } from "@/lib/db/client";
import type { Comment, CommentClassification } from "@/lib/types";

interface CommentRow {
  id: string;
  post_id: string;
  external_id: string | null;
  author: string;
  body: string;
  classification: CommentClassification | null;
  processed_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapComment(row: CommentRow): Comment {
  return {
    id: row.id,
    postId: row.post_id,
    externalId: row.external_id ?? null,
    author: row.author,
    body: row.body,
    classification: row.classification ?? null,
    processedAt: row.processed_at ? toIso(row.processed_at) : null,
    metadata: row.metadata ?? {},
    createdAt: toIso(row.created_at),
  };
}

export async function createComment(input: {
  postId: string;
  author: string;
  body: string;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<Comment> {
  const sql = db();
  const [row] = await sql<CommentRow[]>`
    insert into comments (post_id, author, body, external_id, metadata)
    values (
      ${input.postId},
      ${input.author},
      ${input.body},
      ${input.externalId ?? null},
      ${sql.json((input.metadata ?? {}) as never)}
    )
    returning *
  `;
  return mapComment(row);
}

export async function getComment(id: string): Promise<Comment | null> {
  const sql = db();
  const [row] = await sql<CommentRow[]>`select * from comments where id = ${id}`;
  return row ? mapComment(row) : null;
}

/** Oldest first. */
export async function listComments(
  filter: { postId?: string; unprocessedOnly?: boolean; limit?: number } = {},
): Promise<Comment[]> {
  const sql = db();
  const { postId, unprocessedOnly, limit = 50 } = filter;
  const rows = await sql<CommentRow[]>`
    select * from comments
    where true
      ${postId !== undefined ? sql`and post_id = ${postId}` : sql``}
      ${unprocessedOnly ? sql`and processed_at is null` : sql``}
    order by created_at asc
    limit ${limit}
  `;
  return rows.map(mapComment);
}

export async function updateComment(
  id: string,
  patch: Partial<Pick<Comment, "classification" | "processedAt" | "metadata">>,
): Promise<Comment> {
  const sql = db();
  const assignments: ReturnType<typeof sql>[] = [];
  if (patch.classification !== undefined) assignments.push(sql`classification = ${patch.classification}`);
  if (patch.processedAt !== undefined) assignments.push(sql`processed_at = ${patch.processedAt}`);
  if (patch.metadata !== undefined) assignments.push(sql`metadata = ${sql.json(patch.metadata as never)}`);
  if (assignments.length === 0) {
    const existing = await getComment(id);
    if (!existing) throw new Error(`Comment not found: ${id}`);
    return existing;
  }
  const setClause = assignments.reduce((acc, frag) => sql`${acc}, ${frag}`);

  const [row] = await sql<CommentRow[]>`update comments set ${setClause} where id = ${id} returning *`;
  if (!row) throw new Error(`Comment not found: ${id}`);
  return mapComment(row);
}

export async function findCommentByExternalId(postId: string, externalId: string): Promise<Comment | null> {
  const sql = db();
  const [row] = await sql<CommentRow[]>`
    select * from comments where post_id = ${postId} and external_id = ${externalId}
  `;
  return row ? mapComment(row) : null;
}
