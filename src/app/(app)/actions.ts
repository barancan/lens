"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  approveDraft,
  editDraft,
  publishDraft,
  rejectDraft,
  type DraftKind,
} from "@/lib/approvals/service";
import { requireSession } from "@/lib/auth/server";
import { createThread, deleteThread } from "@/lib/repo/chat";
import { getPost } from "@/lib/repo/posts";
import { SETTINGS_KEYS, type SettingsKey } from "@/lib/settings/schema";
import { removeFocusDirective, SettingsValidationError, updateSettings } from "@/lib/settings/service";
import { runChatTurn } from "@/lib/workflows/chat";
import { getAgentDeps, getKnowledgeService, launchInBackground } from "@/lib/workflows/runtime";
import { ingestComment, startRegeneration, startResearch } from "@/lib/workflows/tasks";

/**
 * Server actions used by the UI. Every action re-checks the session: server
 * actions are reachable by direct POST regardless of the page that uses them.
 */

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

function failure(err: unknown): { ok: false; error: string } {
  if (err instanceof SettingsValidationError) return { ok: false, error: err.message };
  if (err instanceof z.ZodError) return { ok: false, error: z.prettifyError(err) };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

const draftKind = z.enum(["post", "reply"]);
const uuid = z.uuid();

// ---------------------------------------------------------------------------
// Research & tasks
// ---------------------------------------------------------------------------

export async function launchResearchAction(input: { objective?: string; urls?: string }): Promise<ActionResult<{ taskId: string }>> {
  await requireSession();
  try {
    const urls = (input.urls ?? "")
      .split(/\s+/)
      .map((u) => u.trim())
      .filter(Boolean);
    const parsedUrls = z.array(z.url()).max(5).parse(urls);
    const task = await startResearch(getAgentDeps(), {
      objective: z.string().max(1000).optional().parse(input.objective),
      urls: parsedUrls,
      origin: "user",
    });
    revalidatePath("/dashboard");
    revalidatePath("/runs");
    return { ok: true, data: { taskId: task.id } };
  } catch (err) {
    return failure(err);
  }
}

export async function resumeTaskAction(taskId: string): Promise<ActionResult> {
  await requireSession();
  try {
    launchInBackground(uuid.parse(taskId), getAgentDeps(), { resume: true });
    revalidatePath("/runs");
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

// ---------------------------------------------------------------------------
// Drafts (approval queue)
// ---------------------------------------------------------------------------

function revalidateDrafts(id?: string) {
  revalidatePath("/drafts");
  revalidatePath("/dashboard");
  if (id) revalidatePath(`/drafts/${id}`);
}

export async function approveDraftAction(kind: DraftKind, id: string): Promise<ActionResult> {
  await requireSession();
  try {
    await approveDraft(draftKind.parse(kind), uuid.parse(id));
    revalidateDrafts(id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

export async function rejectDraftAction(kind: DraftKind, id: string, reason: string): Promise<ActionResult> {
  await requireSession();
  try {
    await rejectDraft(draftKind.parse(kind), uuid.parse(id), z.string().max(2000).parse(reason ?? ""));
    revalidateDrafts(id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

export async function editDraftAction(
  kind: DraftKind,
  id: string,
  edit: { title?: string; body: string },
): Promise<ActionResult> {
  await requireSession();
  try {
    const parsed = z.object({ title: z.string().min(1).max(200).optional(), body: z.string().min(1).max(20000) }).parse(edit);
    await editDraft(draftKind.parse(kind), uuid.parse(id), parsed);
    revalidateDrafts(id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

export async function regenerateDraftAction(kind: DraftKind, id: string, feedback: string): Promise<ActionResult<{ taskId: string }>> {
  await requireSession();
  try {
    const task = await startRegeneration(getAgentDeps(), {
      kind: draftKind.parse(kind),
      draftId: uuid.parse(id),
      feedback: z.string().min(1, "Feedback is required").max(2000).parse(feedback),
    });
    revalidateDrafts(id);
    return { ok: true, data: { taskId: task.id } };
  } catch (err) {
    return failure(err);
  }
}

export async function publishDraftAction(kind: DraftKind, id: string, externalUrl?: string): Promise<ActionResult> {
  await requireSession();
  try {
    const url = externalUrl?.trim() ? z.url().parse(externalUrl.trim()) : null;
    await publishDraft(draftKind.parse(kind), uuid.parse(id), { externalUrl: url });
    revalidateDrafts(id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/** Manually record a comment on a published post (MVP stand-in for platform ingestion). */
export async function addCommentAction(input: { postId: string; author: string; body: string }): Promise<ActionResult<{ taskId: string }>> {
  await requireSession();
  try {
    const parsed = z
      .object({ postId: uuid, author: z.string().min(1).max(100), body: z.string().min(1).max(10000) })
      .parse(input);
    const post = await getPost(parsed.postId);
    if (!post) throw new Error("Post not found");
    if (post.status !== "published") throw new Error("Comments can only be added to published posts");
    const { task } = await ingestComment(getAgentDeps(), parsed);
    revalidateDrafts(parsed.postId);
    return { ok: true, data: { taskId: task.id } };
  } catch (err) {
    return failure(err);
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createThreadAction(): Promise<void> {
  await requireSession();
  const thread = await createThread();
  redirect(`/chat/${thread.id}`);
}

export async function deleteThreadAction(threadId: string): Promise<void> {
  await requireSession();
  await deleteThread(uuid.parse(threadId));
  revalidatePath("/chat");
  redirect("/chat");
}

export async function sendChatMessageAction(threadId: string, message: string): Promise<ActionResult> {
  await requireSession();
  try {
    const text = z.string().trim().min(1).max(8000).parse(message);
    await runChatTurn(getAgentDeps(), { threadId: uuid.parse(threadId), message: text });
    revalidatePath(`/chat/${threadId}`);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

// ---------------------------------------------------------------------------
// Settings & maintenance
// ---------------------------------------------------------------------------

export async function updateSettingsAction(key: SettingsKey, value: unknown): Promise<ActionResult> {
  await requireSession();
  try {
    if (!SETTINGS_KEYS.includes(key)) throw new Error(`Unknown settings key ${key}`);
    await updateSettings(key, value);
    revalidatePath("/settings");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

export async function removeFocusDirectiveAction(index: number): Promise<ActionResult> {
  await requireSession();
  try {
    await removeFocusDirective(z.number().int().min(0).parse(index));
    revalidatePath("/settings");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

export async function backfillEmbeddingsAction(): Promise<ActionResult<{ updated: number }>> {
  await requireSession();
  try {
    const result = await getKnowledgeService().backfillEmbeddings(200);
    const updated = typeof result === "number" ? result : Object.values(result as Record<string, number>).reduce((a, b) => a + b, 0);
    revalidatePath("/knowledge");
    return { ok: true, data: { updated } };
  } catch (err) {
    return failure(err);
  }
}
