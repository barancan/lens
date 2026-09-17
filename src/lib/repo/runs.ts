import { db } from "@/lib/db/client";
import type { AgentRun, LLMCallLog, RunStatus, RunStepLog, ToolCallLog, Usage } from "@/lib/types";

interface RunRow {
  id: string;
  workflow: string;
  provider: string | null;
  model: string | null;
  task_id: string | null;
  status: RunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  steps: RunStepLog[];
  tool_calls: ToolCallLog[];
  llm_calls: LLMCallLog[];
  usage: Usage;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    workflow: row.workflow,
    provider: row.provider ?? null,
    model: row.model ?? null,
    taskId: row.task_id ?? null,
    status: row.status,
    input: row.input ?? {},
    output: row.output ?? null,
    steps: row.steps ?? [],
    toolCalls: row.tool_calls ?? [],
    llmCalls: row.llm_calls ?? [],
    usage: row.usage ?? { inputTokens: 0, outputTokens: 0 },
    error: row.error ?? null,
    startedAt: toIso(row.started_at),
    finishedAt: row.finished_at ? toIso(row.finished_at) : null,
  };
}

export async function createRun(input: {
  workflow: string;
  taskId?: string | null;
  provider?: string | null;
  model?: string | null;
  input?: Record<string, unknown>;
}): Promise<AgentRun> {
  const sql = db();
  const [row] = await sql<RunRow[]>`
    insert into agent_runs (workflow, task_id, provider, model, input)
    values (
      ${input.workflow},
      ${input.taskId ?? null},
      ${input.provider ?? null},
      ${input.model ?? null},
      ${sql.json((input.input ?? {}) as never)}
    )
    returning *
  `;
  return mapRun(row);
}

export async function getRun(id: string): Promise<AgentRun | null> {
  const sql = db();
  const [row] = await sql<RunRow[]>`select * from agent_runs where id = ${id}`;
  return row ? mapRun(row) : null;
}

export async function listRuns(
  filter: { taskId?: string; workflow?: string; status?: RunStatus; limit?: number } = {},
): Promise<AgentRun[]> {
  const sql = db();
  const { taskId, workflow, status, limit = 50 } = filter;
  const rows = await sql<RunRow[]>`
    select * from agent_runs
    where true
      ${taskId !== undefined ? sql`and task_id = ${taskId}` : sql``}
      ${workflow !== undefined ? sql`and workflow = ${workflow}` : sql``}
      ${status !== undefined ? sql`and status = ${status}` : sql``}
    order by started_at desc
    limit ${limit}
  `;
  return rows.map(mapRun);
}

export async function appendRunStep(id: string, step: RunStepLog): Promise<AgentRun> {
  const sql = db();
  const [row] = await sql<RunRow[]>`
    update agent_runs
    set steps = steps || ${sql.json([step] as never)}::jsonb
    where id = ${id}
    returning *
  `;
  if (!row) throw new Error(`Run not found: ${id}`);
  return mapRun(row);
}

export async function appendToolCall(id: string, call: ToolCallLog): Promise<AgentRun> {
  const sql = db();
  const [row] = await sql<RunRow[]>`
    update agent_runs
    set tool_calls = tool_calls || ${sql.json([call] as never)}::jsonb
    where id = ${id}
    returning *
  `;
  if (!row) throw new Error(`Run not found: ${id}`);
  return mapRun(row);
}

/**
 * Appends an LLM call log, atomically accumulates usage, and backfills
 * provider/model on the run if they are still unset.
 */
export async function appendLlmCall(id: string, call: LLMCallLog): Promise<AgentRun> {
  const sql = db();
  const [row] = await sql<RunRow[]>`
    update agent_runs
    set llm_calls = llm_calls || ${sql.json([call] as never)}::jsonb,
        usage = jsonb_set(
          jsonb_set(
            usage,
            '{inputTokens}',
            to_jsonb(coalesce((usage->>'inputTokens')::int, 0) + ${call.inputTokens}::int)
          ),
          '{outputTokens}',
          to_jsonb(coalesce((usage->>'outputTokens')::int, 0) + ${call.outputTokens}::int)
        ),
        provider = coalesce(provider, ${call.provider}),
        model = coalesce(model, ${call.model})
    where id = ${id}
    returning *
  `;
  if (!row) throw new Error(`Run not found: ${id}`);
  return mapRun(row);
}

export async function finishRun(
  id: string,
  result: { status: "succeeded" | "failed"; output?: Record<string, unknown> | null; error?: string | null },
): Promise<AgentRun> {
  const sql = db();
  const assignments: ReturnType<typeof sql>[] = [sql`status = ${result.status}`, sql`finished_at = now()`];
  if ("output" in result) {
    assignments.push(
      sql`output = ${result.output === null || result.output === undefined ? null : sql.json(result.output as never)}`,
    );
  }
  if ("error" in result) assignments.push(sql`error = ${result.error ?? null}`);
  const setClause = assignments.reduce((acc, frag) => sql`${acc}, ${frag}`);

  const [row] = await sql<RunRow[]>`update agent_runs set ${setClause} where id = ${id} returning *`;
  if (!row) throw new Error(`Run not found: ${id}`);
  return mapRun(row);
}
