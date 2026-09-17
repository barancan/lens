import { db } from "@/lib/db/client";
import type { ChatMessage, ChatThread, ToolCallLog } from "@/lib/types";

interface ThreadRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: ToolCallLog[];
  run_id: string | null;
  created_at: Date;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapThread(row: ThreadRow): ChatThread {
  return {
    id: row.id,
    title: row.title,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ?? [],
    runId: row.run_id ?? null,
    createdAt: toIso(row.created_at),
  };
}

export async function createThread(title?: string): Promise<ChatThread> {
  const sql = db();
  const [row] = title
    ? await sql<ThreadRow[]>`insert into chat_threads (title) values (${title}) returning *`
    : await sql<ThreadRow[]>`insert into chat_threads default values returning *`;
  return mapThread(row);
}

/** Newest-updated first. */
export async function listThreads(limit = 50): Promise<ChatThread[]> {
  const sql = db();
  const rows = await sql<ThreadRow[]>`
    select * from chat_threads order by updated_at desc limit ${limit}
  `;
  return rows.map(mapThread);
}

export async function getThread(id: string): Promise<ChatThread | null> {
  const sql = db();
  const [row] = await sql<ThreadRow[]>`select * from chat_threads where id = ${id}`;
  return row ? mapThread(row) : null;
}

export async function renameThread(id: string, title: string): Promise<ChatThread> {
  const sql = db();
  const [row] = await sql<ThreadRow[]>`
    update chat_threads set title = ${title}, updated_at = now() where id = ${id} returning *
  `;
  if (!row) throw new Error(`Thread not found: ${id}`);
  return mapThread(row);
}

export async function deleteThread(id: string): Promise<void> {
  const sql = db();
  await sql`delete from chat_threads where id = ${id}`;
}

export async function addMessage(input: {
  threadId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallLog[];
  runId?: string | null;
}): Promise<ChatMessage> {
  const sql = db();
  const [row] = await sql<MessageRow[]>`
    insert into chat_messages (thread_id, role, content, tool_calls, run_id)
    values (
      ${input.threadId},
      ${input.role},
      ${input.content},
      ${sql.json((input.toolCalls ?? []) as never)},
      ${input.runId ?? null}
    )
    returning *
  `;
  await sql`update chat_threads set updated_at = now() where id = ${input.threadId}`;
  return mapMessage(row);
}

/** Oldest first. */
export async function listMessages(threadId: string, limit = 100): Promise<ChatMessage[]> {
  const sql = db();
  const rows = await sql<MessageRow[]>`
    select * from chat_messages where thread_id = ${threadId} order by created_at asc limit ${limit}
  `;
  return rows.map(mapMessage);
}
