import { db } from "@/lib/db/client";
import { TASK_STATUSES, type Task, type TaskOrigin, type TaskStatus, type TaskType } from "@/lib/types";

/** Raw row shape as returned by postgres.js (snake_case; jsonb pre-parsed; timestamps as Date). */
interface TaskRow {
  id: string;
  type: TaskType;
  objective: string;
  status: TaskStatus;
  origin: TaskOrigin;
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  parent_task_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    type: row.type,
    objective: row.objective,
    status: row.status,
    origin: row.origin,
    input: row.input ?? {},
    state: row.state ?? {},
    output: row.output ?? null,
    error: row.error ?? null,
    parentTaskId: row.parent_task_id ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  };
}

export async function createTask(input: {
  type: TaskType;
  objective: string;
  origin: TaskOrigin;
  input?: Record<string, unknown>;
  parentTaskId?: string | null;
}): Promise<Task> {
  const sql = db();
  const [row] = await sql<TaskRow[]>`
    insert into tasks (type, objective, origin, input, parent_task_id)
    values (
      ${input.type},
      ${input.objective},
      ${input.origin},
      ${sql.json((input.input ?? {}) as never)},
      ${input.parentTaskId ?? null}
    )
    returning *
  `;
  return mapTask(row);
}

export async function getTask(id: string): Promise<Task | null> {
  const sql = db();
  const [row] = await sql<TaskRow[]>`select * from tasks where id = ${id}`;
  return row ? mapTask(row) : null;
}

export async function listTasks(
  filter: { statuses?: TaskStatus[]; types?: TaskType[]; limit?: number } = {},
): Promise<Task[]> {
  const sql = db();
  const { statuses, types, limit = 50 } = filter;
  const rows = await sql<TaskRow[]>`
    select * from tasks
    where true
      ${statuses && statuses.length ? sql`and status = any(${statuses})` : sql``}
      ${types && types.length ? sql`and type = any(${types})` : sql``}
    order by created_at desc
    limit ${limit}
  `;
  return rows.map(mapTask);
}

export async function updateTask(
  id: string,
  patch: Partial<Pick<Task, "status" | "state" | "output" | "error" | "completedAt">>,
): Promise<Task> {
  const sql = db();
  const assignments: ReturnType<typeof sql>[] = [];
  if (patch.status !== undefined) assignments.push(sql`status = ${patch.status}`);
  if (patch.state !== undefined) assignments.push(sql`state = ${sql.json(patch.state as never)}`);
  if (patch.output !== undefined) {
    assignments.push(sql`output = ${patch.output === null ? null : sql.json(patch.output as never)}`);
  }
  if (patch.error !== undefined) assignments.push(sql`error = ${patch.error}`);
  if (patch.completedAt !== undefined) assignments.push(sql`completed_at = ${patch.completedAt}`);
  assignments.push(sql`updated_at = now()`);
  const setClause = assignments.reduce((acc, frag) => sql`${acc}, ${frag}`);

  const [row] = await sql<TaskRow[]>`update tasks set ${setClause} where id = ${id} returning *`;
  if (!row) throw new Error(`Task not found: ${id}`);
  return mapTask(row);
}

/** Atomic claim: only succeeds if the task is currently in one of `fromStatuses`. */
export async function claimTask(
  id: string,
  fromStatuses: TaskStatus[] = ["queued", "failed"],
): Promise<Task | null> {
  const sql = db();
  const [row] = await sql<TaskRow[]>`
    update tasks
    set status = 'running', error = null, updated_at = now()
    where id = ${id} and status = any(${fromStatuses})
    returning *
  `;
  return row ? mapTask(row) : null;
}

export async function countTasksByStatus(): Promise<Record<TaskStatus, number>> {
  const sql = db();
  const rows = await sql<{ status: TaskStatus; count: number }[]>`
    select status, count(*)::int as count from tasks group by status
  `;
  const result = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const row of rows) result[row.status] = row.count;
  return result;
}
