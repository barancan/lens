import { db } from "@/lib/db/client";
import type { DraftMetadata, DraftStatus, Post } from "@/lib/types";

interface PostRow {
  id: string;
  title: string;
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

function mapPost(row: PostRow): Post {
  return {
    id: row.id,
    title: row.title,
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

export async function createPost(input: {
  title: string;
  body: string;
  status?: DraftStatus;
  taskId?: string | null;
  runId?: string | null;
  metadata?: DraftMetadata;
}): Promise<Post> {
  const sql = db();
  const [row] = await sql<PostRow[]>`
    insert into posts (title, body, status, task_id, run_id, metadata)
    values (
      ${input.title},
      ${input.body},
      ${input.status ?? "draft"},
      ${input.taskId ?? null},
      ${input.runId ?? null},
      ${sql.json((input.metadata ?? {}) as never)}
    )
    returning *
  `;
  return mapPost(row);
}

export async function getPost(id: string): Promise<Post | null> {
  const sql = db();
  const [row] = await sql<PostRow[]>`select * from posts where id = ${id}`;
  return row ? mapPost(row) : null;
}

export async function listPosts(filter: { statuses?: DraftStatus[]; limit?: number } = {}): Promise<Post[]> {
  const sql = db();
  const { statuses, limit = 50 } = filter;
  const rows = await sql<PostRow[]>`
    select * from posts
    where true
      ${statuses && statuses.length ? sql`and status = any(${statuses})` : sql``}
    order by created_at desc
    limit ${limit}
  `;
  return rows.map(mapPost);
}

export async function updatePost(
  id: string,
  patch: Partial<
    Pick<Post, "title" | "body" | "status" | "metadata" | "approvedAt" | "publishedAt" | "externalId" | "externalUrl">
  >,
): Promise<Post> {
  const sql = db();
  const assignments: ReturnType<typeof sql>[] = [];
  if (patch.title !== undefined) assignments.push(sql`title = ${patch.title}`);
  if (patch.body !== undefined) assignments.push(sql`body = ${patch.body}`);
  if (patch.status !== undefined) assignments.push(sql`status = ${patch.status}`);
  if (patch.metadata !== undefined) assignments.push(sql`metadata = ${sql.json(patch.metadata as never)}`);
  if (patch.approvedAt !== undefined) assignments.push(sql`approved_at = ${patch.approvedAt}`);
  if (patch.publishedAt !== undefined) assignments.push(sql`published_at = ${patch.publishedAt}`);
  if (patch.externalId !== undefined) assignments.push(sql`external_id = ${patch.externalId}`);
  if (patch.externalUrl !== undefined) assignments.push(sql`external_url = ${patch.externalUrl}`);
  assignments.push(sql`updated_at = now()`);
  const setClause = assignments.reduce((acc, frag) => sql`${acc}, ${frag}`);

  const [row] = await sql<PostRow[]>`update posts set ${setClause} where id = ${id} returning *`;
  if (!row) throw new Error(`Post not found: ${id}`);
  return mapPost(row);
}
