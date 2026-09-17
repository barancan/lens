import type { Settings } from "@/lib/settings/schema";
import { getAllSettings } from "@/lib/settings/service";
import { appendRunStep, appendToolCall, createRun, finishRun } from "@/lib/repo/runs";
import { claimTask, updateTask } from "@/lib/repo/tasks";
import type { Task, TaskStatus, ToolCallLog } from "@/lib/types";
import { createLlmGateway } from "./llm-gateway";
import {
  LimitExceededError,
  type AgentDeps,
  type BaseState,
  type Checkpoint,
  type RunContext,
  type WorkflowDefinition,
} from "./types";

/**
 * Explicit, bounded workflow executor.
 *
 * - Steps run strictly in order; there is no recursion or self-scheduling.
 * - After every step the state is checkpointed to `tasks.state`, so a failed or
 *   timed-out task can be resumed and completed steps are skipped.
 * - Every step, tool call and LLM call is appended to the `agent_runs` row.
 */

export interface RunOutcome {
  taskId: string;
  runId: string | null;
  status: TaskStatus;
  error?: string;
}

const MAX_LOGGED_OUTPUT_CHARS = 4000;

function truncateForLog(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= MAX_LOGGED_OUTPUT_CHARS) return value;
  return { truncated: true, preview: text.slice(0, MAX_LOGGED_OUTPUT_CHARS) };
}

/** One-line progress log for the dev-server terminal / Vercel function logs. */
function log(runId: string, workflow: string, message: string, level: "info" | "error" = "info") {
  const line = `[lens] ${workflow} run ${runId.slice(0, 8)}: ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

function seconds(fromMs: number): string {
  return `${((Date.now() - fromMs) / 1000).toFixed(1)}s`;
}

function readCheckpoint<S extends BaseState>(task: Task, def: WorkflowDefinition<S>): Checkpoint<S> {
  const state = task.state as Partial<Checkpoint<S>>;
  if (state && Array.isArray(state.completedSteps) && state.data) {
    return { completedSteps: state.completedSteps, data: state.data };
  }
  return { completedSteps: [], data: def.initialState(task) };
}

/** Build the per-run context (LLM gateway, traced tool execution with a call budget). */
export function buildRunContext(input: { runId: string; task: Task | null; settings: Settings; deps: AgentDeps }): RunContext {
  const { runId, settings } = input;
  const calls: ToolCallLog[] = [];
  const maxToolCalls = settings.limits.maxToolCalls;
  let budgetedCalls = 0;
  return {
    ...input,
    llm: createLlmGateway(runId, settings.models, input.deps.getProvider),
    toolCalls: () => calls,
    async trace(tool, toolInput, fn, summarize, opts) {
      if (!opts?.bookkeeping) {
        if (budgetedCalls >= maxToolCalls) {
          throw new LimitExceededError(
            `Tool call limit reached (${maxToolCalls}) before "${tool}". Raise "Max tool calls" in Settings → Limits, then resume the task.`,
          );
        }
        budgetedCalls++;
      }
      const started = Date.now();
      const log: ToolCallLog = {
        tool,
        input: truncateForLog(toolInput),
        ok: true,
        durationMs: 0,
        at: new Date(started).toISOString(),
      };
      try {
        const out = await fn();
        log.output = truncateForLog(summarize ? summarize(out) : out);
        return out;
      } catch (err) {
        log.ok = false;
        log.error = err instanceof Error ? err.message : String(err);
        console.warn(`[lens] run ${runId.slice(0, 8)}: tool ${tool} failed: ${log.error}`);
        throw err;
      } finally {
        log.durationMs = Date.now() - started;
        calls.push(log);
        await appendToolCall(runId, log);
      }
    },
  };
}

/** Wraps a step failure so the stored error names the step that failed. */
class StepError extends Error {
  constructor(step: string, cause: unknown) {
    super(`Step "${step}" failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StepError";
  }
}

export async function executeWorkflow<S extends BaseState>(
  def: WorkflowDefinition<S>,
  taskId: string,
  deps: AgentDeps,
  opts: { resume?: boolean } = {},
): Promise<RunOutcome> {
  // Atomically take ownership; prevents double execution of the same task.
  const task = await claimTask(taskId, opts.resume ? ["queued", "failed", "running"] : ["queued"]);
  if (!task) return { taskId, runId: null, status: "cancelled", error: "Task is not runnable (already running or finished)" };

  const settings = await getAllSettings();
  const primary = settings.models[def.primaryModel];
  const checkpoint = readCheckpoint(task, def);
  const run = await createRun({
    workflow: def.name,
    taskId: task.id,
    provider: primary.provider,
    model: primary.model,
    input: { objective: task.objective, ...task.input, resumedFrom: checkpoint.completedSteps },
  });

  const ctx = buildRunContext({ runId: run.id, task, settings, deps });

  let state = checkpoint.data;
  const completed = [...checkpoint.completedSteps];
  const runStarted = Date.now();
  log(
    run.id,
    def.name,
    `started task ${task.id}${completed.length ? ` (resuming after ${completed.join(", ")})` : ""}`,
  );

  try {
    for (const step of def.steps) {
      if (state.halted) break;
      if (completed.includes(step.name)) {
        continue;
      }
      const stepStarted = Date.now();
      const startedAt = new Date(stepStarted).toISOString();
      log(run.id, def.name, `step ${step.name} started`);
      try {
        const patch = await step.run(state, ctx);
        state = { ...state, ...patch };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(run.id, def.name, `step ${step.name} FAILED after ${seconds(stepStarted)}: ${message}`, "error");
        await appendRunStep(run.id, {
          name: step.name,
          status: "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          error: message,
        });
        throw new StepError(step.name, err);
      }
      completed.push(step.name);
      const summary = step.summarize?.(state) ?? (state.halted ? `halted: ${state.halted}` : undefined);
      log(run.id, def.name, `step ${step.name} done in ${seconds(stepStarted)}${summary ? `: ${summary}` : ""}`);
      await appendRunStep(run.id, {
        name: step.name,
        status: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary,
      });
      await updateTask(task.id, { state: { completedSteps: completed, data: state } });
    }

    const status = def.finalStatus(state);
    const output = { ...def.output(state), halted: state.halted ?? null };
    await updateTask(task.id, { status, output, error: null, completedAt: new Date().toISOString() });
    await finishRun(run.id, { status: "succeeded", output });
    log(run.id, def.name, `finished in ${seconds(runStarted)} with status ${status}${state.halted ? ` (halted: ${state.halted})` : ""}`);
    return { taskId: task.id, runId: run.id, status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(run.id, def.name, `FAILED after ${seconds(runStarted)}: ${message}. Resume task ${task.id} from the Runs page.`, "error");
    // Limit errors are expected and self-explanatory; anything else gets a stack trace.
    const cause = err instanceof StepError ? err.cause : err;
    if (!(cause instanceof LimitExceededError)) console.error(cause);
    await updateTask(task.id, { status: "failed", error: message, state: { completedSteps: completed, data: state } });
    await finishRun(run.id, { status: "failed", error: message });
    return { taskId: task.id, runId: run.id, status: "failed", error: message };
  }
}
