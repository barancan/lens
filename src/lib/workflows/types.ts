import type { KnowledgeService } from "@/lib/knowledge/service";
import type { ProviderName, LLMProvider } from "@/lib/llm/types";
import type { ResearchSource, SourceDocument } from "@/lib/research/types";
import type { Settings, WorkflowModelKey } from "@/lib/settings/schema";
import type { Task, TaskStatus, ToolCallLog } from "@/lib/types";
import type { LlmGateway } from "./llm-gateway";

/** Everything a workflow needs from the outside world. Injected so workflows are testable. */
export interface AgentDeps {
  knowledge: KnowledgeService;
  getProvider(name: ProviderName): LLMProvider;
  getResearchSources(enabledIds: string[]): ResearchSource[];
  fetchUrl(url: string): Promise<SourceDocument>;
  /** Fire-and-forget execution of a queued task (Vercel: `after()`). */
  launchTask(taskId: string): void;
}

export class LimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitExceededError";
  }
}

export interface RunContext {
  runId: string;
  /** Null for chat turns, which are not tasks. */
  task: Task | null;
  settings: Settings;
  deps: AgentDeps;
  llm: LlmGateway;
  /**
   * Execute and log an external/tool operation, counting it against the
   * run's tool-call budget. Errors are logged and re-thrown.
   */
  trace<T>(tool: string, input: unknown, fn: () => Promise<T>, summarize?: (out: T) => unknown): Promise<T>;
  toolCalls(): ToolCallLog[];
}

/** Base shape of every persisted workflow state. */
export interface BaseState {
  /** Set by a step to end the workflow early (not an error). */
  halted?: string;
}

export interface WorkflowStep<S extends BaseState> {
  name: string;
  run(state: S, ctx: RunContext): Promise<Partial<S>>;
  /** Short human-readable summary of what the step produced, for the Runs page. */
  summarize?(state: S): string;
}

export interface WorkflowDefinition<S extends BaseState> {
  name: string;
  /** Model key shown on the run record (the workflow may use others per step). */
  primaryModel: WorkflowModelKey;
  initialState(task: Task): S;
  steps: WorkflowStep<S>[];
  /** Status the task ends in when all steps succeed or the workflow halts. */
  finalStatus(state: S): Extract<TaskStatus, "completed" | "awaiting_approval">;
  output(state: S): Record<string, unknown>;
}

/** Persisted in tasks.state. */
export interface Checkpoint<S> {
  completedSteps: string[];
  data: S;
}
