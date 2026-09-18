import { createComment } from "@/lib/repo/comments";
import { createTask, getTask } from "@/lib/repo/tasks";
import type { Comment, Task, TaskOrigin } from "@/lib/types";
import { commentWorkflow } from "./comment";
import { discoverWorkflow } from "./discover";
import { executeWorkflow, type RunOutcome } from "./engine";
import { regenerateWorkflow } from "./regenerate";
import { researchWorkflow } from "./research";
import type { AgentDeps } from "./types";

/**
 * Task entry points. UI routes, cron and chat tools call these; they create a
 * task row and hand execution to `deps.launchTask` (background) or run inline.
 */

export async function runTask(taskId: string, deps: AgentDeps, opts: { resume?: boolean } = {}): Promise<RunOutcome> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  switch (task.type) {
    case "research":
      return executeWorkflow(researchWorkflow, taskId, deps, opts);
    case "comment_reply":
      return executeWorkflow(commentWorkflow, taskId, deps, opts);
    case "regenerate_draft":
      return executeWorkflow(regenerateWorkflow, taskId, deps, opts);
    case "discover":
      return executeWorkflow(discoverWorkflow, taskId, deps, opts);
  }
}

export async function startResearch(
  deps: AgentDeps,
  input: { objective?: string; urls?: string[]; origin: TaskOrigin; parentTaskId?: string | null },
): Promise<Task> {
  const objective =
    input.objective?.trim() ||
    "Advance the core research question: identify the most important open question or weakly supported claim and look for new primary evidence.";
  const task = await createTask({
    type: "research",
    objective,
    origin: input.origin,
    input: input.urls?.length ? { urls: input.urls } : {},
    parentTaskId: input.parentTaskId ?? null,
  });
  deps.launchTask(task.id);
  return task;
}

/**
 * Search a community platform for work near our research question and turn what
 * it finds into open questions. Queries default to the research question itself.
 */
export async function startDiscovery(
  deps: AgentDeps,
  input: { queries?: string[]; topic?: string; origin: TaskOrigin },
): Promise<Task> {
  const queries = (input.queries ?? []).map((q) => q.trim()).filter(Boolean);
  const objective = queries.length
    ? `Discover community work on: ${queries.join("; ")}`
    : "Discover community work related to the core research question";
  const task = await createTask({
    type: "discover",
    objective,
    origin: input.origin,
    input: { ...(queries.length ? { queries } : {}), ...(input.topic ? { topic: input.topic } : {}) },
  });
  deps.launchTask(task.id);
  return task;
}

/** Record a comment on a published post and start the reply workflow. */
export async function ingestComment(
  deps: AgentDeps,
  input: { postId: string; author: string; body: string; externalId?: string | null; metadata?: Record<string, unknown> },
): Promise<{ comment: Comment; task: Task }> {
  const comment = await createComment(input);
  return {
    comment,
    task: await ingestCommentTask(deps, comment.id, { objective: `Respond to comment by ${input.author}` }),
  };
}

/**
 * Start the reply workflow for an already-stored comment. `origin` defaults
 * to "user" but a scheduled poller passes "schedule" so runs are attributable.
 */
export async function ingestCommentTask(
  deps: AgentDeps,
  commentId: string,
  opts: { objective?: string; origin?: TaskOrigin } = {},
): Promise<Task> {
  const { objective = "Respond to comment", origin = "user" } = opts;
  const task = await createTask({ type: "comment_reply", objective, origin, input: { commentId } });
  deps.launchTask(task.id);
  return task;
}

export async function startRegeneration(
  deps: AgentDeps,
  input: { kind: "post" | "reply"; draftId: string; feedback: string },
): Promise<Task> {
  const task = await createTask({
    type: "regenerate_draft",
    objective: `Regenerate ${input.kind} ${input.draftId}`,
    origin: "user",
    input,
  });
  deps.launchTask(task.id);
  return task;
}
