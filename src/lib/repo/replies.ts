import { db } from "@/lib/db/client";
import type { DraftMetadata, DraftStatus, Reply } from "@/lib/types";

interface ReplyRow {
  id: string;
  comment_id: string;
  post_id: string;
  body: string;
  status: DraftStatus;
  task_id: string | null;
  run_id: string | null;
  external_id: string | null;
  external_url: string | null;
  metadata: DraftMetadata;
  created_at: Date;
  updated_at: Date;
  approved_at: Date | null;
  published_at: Date | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapReply(row: ReplyRow): Reply {
  return {
    id: row.id,
    commentId: row.comment_id,
    postId: row.post_id,
    body: row.body,
    status: row.status,
    taskId: row.task_id ?? null,
    runId: row.run_id ?? null,
    externalId: row.external_id ?? null,
    externalUrl: row.external_url ?? null,
    metadata: row.metadata ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    approvedAt: row.approved_at ? toIso(row.approved_at) : null,
    publishedAt: row.published_at ? toIso(row.published_at) : null,
  };
}

export async function createReply(input: {
  commentId: string;
  postId: string;
  body: string;
  status?: DraftStatus;
  taskId?: string | null;
  runId?: string | null;
  metadata?: DraftMetadata;
}): Promise<Reply> {
  const sql = db();
  const [row] = await sql<ReplyRow[]>`
    insert into replies (comment_id, post_id, body, status, task_id, run_id, metadata)
    values (
      ${input.commentId},
      ${input.postId},
      ${input.body},
      ${input.status ?? "draft"},
      ${input.taskId ?? null},
      ${input.runId ?? null},
      ${sql.json((input.metadata ?? {}) as never)}
    )
    returning *
  `;
  return mapReply(row);
}

export async function getReply(id: string): Promise<Reply | null> {
  const sql = db();
  const [row] = await sql<ReplyRow[]>`select * from replies where id = ${id}`;
  return row ? mapReply(row) : null;
}

export async function listReplies(
  filter: { statuses?: DraftStatus[]; postId?: string; commentId?: string; limit?: number } = {},
): Promise<Reply[]> {
  const sql = db();
  const { statuses, postId, commentId, limit = 50 } = filter;
  const rows = await sql<ReplyRow[]>`
    select * from replies
    where true
      ${statuses && statuses.length ? sql`and status = any(${statuses})` : sql``}
      ${postId !== undefined ? sql`and post_id = ${postId}` : sql``}
      ${commentId !== undefined ? sql`and comment_id = ${commentId}` : sql``}
    order by created_at desc
    limit ${limit}
  `;
  return rows.map(mapReply);
}

/**
 * Compare-and-swap publish claim: only wins when the row is still `approved`.
 * Mirrors `claimForPublish` in `repo/posts.ts` — see there for why this needs
 * to be a single atomic UPDATE rather than a read-then-write.
 */
export async function claimForPublish(id: string): Promise<Reply | null> {
  const sql = db();
  const [row] = await sql<ReplyRow[]>`
    update replies
    set status = 'published', published_at = now(), updated_at = now()
    where id = ${id} and status = 'approved'
    returning *
  `;
  return row ? mapReply(row) : null;
}

export async function findReplyByExternalId(externalId: string): Promise<Reply | null> {
  const sql = db();
  const [row] = await sql<ReplyRow[]>`
    select * from replies where external_id = ${externalId}
  `;
  return row ? mapReply(row) : null;
}

export async function updateReply(
  id: string,
  patch: Partial<
    Pick<Reply, "body" | "status" | "metadata" | "approvedAt" | "publishedAt" | "externalId" | "externalUrl">
  >,
): Promise<Reply> {
  const sql = db();
  const assignments: ReturnType<typeof sql>[] = [];
  if (patch.body !== undefined) assignments.push(sql`body = ${patch.body}`);
  if (patch.status !== undefined) assignments.push(sql`status = ${patch.status}`);
  if (patch.metadata !== undefined) assignments.push(sql`metadata = ${sql.json(patch.metadata as never)}`);
  if (patch.approvedAt !== undefined) assignments.push(sql`approved_at = ${patch.approvedAt}`);
  if (patch.publishedAt !== undefined) assignments.push(sql`published_at = ${patch.publishedAt}`);
  if (patch.externalId !== undefined) assignments.push(sql`external_id = ${patch.externalId}`);
  if (patch.externalUrl !== undefined) assignments.push(sql`external_url = ${patch.externalUrl}`);
  assignments.push(sql`updated_at = now()`);
  const setClause = assignments.reduce((acc, frag) => sql`${acc}, ${frag}`);

  const [row] = await sql<ReplyRow[]>`update replies set ${setClause} where id = ${id} returning *`;
  if (!row) throw new Error(`Reply not found: ${id}`);
  return mapReply(row);
}
