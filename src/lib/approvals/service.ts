import { InvalidTransitionError, nextStatus } from "@/lib/approvals/lifecycle";
import { getPublisher } from "@/lib/approvals/publisher";
import type { PublishHints, Publisher } from "@/lib/integrations/types";
import { getComment } from "@/lib/repo/comments";
import { claimForPublish as claimPostForPublish, getPost, updatePost } from "@/lib/repo/posts";
import { claimForPublish as claimReplyForPublish, getReply, updateReply } from "@/lib/repo/replies";
import { getSettings } from "@/lib/settings/service";
import type { DraftMetadata, DraftRevision, DraftStatus, Post, Reply } from "@/lib/types";

/**
 * Operator actions on drafts (posts and replies). All status changes go
 * through `nextStatus`, so invalid transitions throw.
 */

export type DraftKind = "post" | "reply";
export type Draft = ({ kind: "post" } & Post) | ({ kind: "reply" } & Reply);

export class DraftNotFoundError extends Error {
  constructor(kind: DraftKind, id: string) {
    super(`${kind} ${id} not found`);
    this.name = "DraftNotFoundError";
  }
}

export async function getDraft(kind: DraftKind, id: string): Promise<Draft> {
  if (kind === "post") {
    const post = await getPost(id);
    if (post) return { kind, ...post };
  } else {
    const reply = await getReply(id);
    if (reply) return { kind, ...reply };
  }
  throw new DraftNotFoundError(kind, id);
}

interface DraftPatch {
  title?: string;
  body?: string;
  status?: DraftStatus;
  metadata?: DraftMetadata;
  approvedAt?: string | null;
  publishedAt?: string | null;
  externalId?: string | null;
  externalUrl?: string | null;
}

async function saveDraft(kind: DraftKind, id: string, patch: DraftPatch): Promise<Draft> {
  if (kind === "post") return { kind, ...(await updatePost(id, patch)) };
  const { title: _ignored, ...replyPatch } = patch;
  return { kind, ...(await updateReply(id, replyPatch)) };
}

function withRevision(draft: Draft, revision: DraftRevision, extra: Partial<DraftMetadata> = {}): DraftMetadata {
  return { ...draft.metadata, ...extra, revisions: [...(draft.metadata.revisions ?? []), revision] };
}

function snapshot(draft: Draft, by: DraftRevision["by"], note: string): DraftRevision {
  return {
    at: new Date().toISOString(),
    by,
    title: draft.kind === "post" ? draft.title : undefined,
    body: draft.body,
    note,
  };
}

export async function approveDraft(kind: DraftKind, id: string): Promise<Draft> {
  const draft = await getDraft(kind, id);
  return saveDraft(kind, id, { status: nextStatus(draft.status, "approve"), approvedAt: new Date().toISOString() });
}

export async function rejectDraft(kind: DraftKind, id: string, reason: string): Promise<Draft> {
  const draft = await getDraft(kind, id);
  return saveDraft(kind, id, {
    status: nextStatus(draft.status, "reject"),
    approvedAt: null,
    metadata: { ...draft.metadata, rejectionReason: reason || undefined },
  });
}

/** Operator edit. The previous version is kept in metadata.revisions. */
export async function editDraft(kind: DraftKind, id: string, edit: { title?: string; body: string }): Promise<Draft> {
  const draft = await getDraft(kind, id);
  const status = nextStatus(draft.status, "edit");
  return saveDraft(kind, id, {
    status,
    title: draft.kind === "post" ? (edit.title ?? draft.title) : undefined,
    body: edit.body,
    metadata: withRevision(draft, snapshot(draft, "operator", "before operator edit")),
  });
}

/** Called by the regenerate workflow once a new version has been written. */
export async function applyRegeneratedDraft(
  kind: DraftKind,
  id: string,
  next: { title?: string; body: string; rationale?: string; model?: string; provider?: string },
  feedback: string,
): Promise<Draft> {
  const draft = await getDraft(kind, id);
  return saveDraft(kind, id, {
    status: nextStatus(draft.status, "regenerate"),
    title: draft.kind === "post" ? (next.title ?? draft.title) : undefined,
    body: next.body,
    approvedAt: null,
    metadata: withRevision(draft, snapshot(draft, "agent", `before regeneration: ${feedback}`), {
      rationale: next.rationale ?? draft.metadata.rationale,
      model: next.model ?? draft.metadata.model,
      provider: next.provider ?? draft.metadata.provider,
      rejectionReason: undefined,
    }),
  });
}

/**
 * Publish an APPROVED draft through the configured publisher adapter.
 *
 * Concurrency safety: `nextStatus` only blocks a *sequential* second click —
 * two concurrent calls can both read `approved` before either writes. So the
 * actual `approved -> published` transition happens via `claimForPublish`,
 * a compare-and-swap `UPDATE ... where status = 'approved'` in the repo
 * layer: only one concurrent caller's UPDATE matches a row, so only one
 * caller ever invokes the publisher. The loser re-reads the (now-claimed)
 * row and throws `InvalidTransitionError`, exactly as a legitimate
 * already-published call would.
 *
 * If the publisher call fails after the claim succeeded, the draft is rolled
 * back to `approved` (with the failure recorded in `metadata.lastPublishError`
 * / `metadata.lastPublishAttemptAt`) so the operator can simply retry. The
 * one case this cannot close automatically is the platform accepting the
 * write but the HTTP response never arriving (timeout/abort): the adapter
 * surfaces that ambiguity in its error message, and recovery is the
 * operator's `linkExternalPostAction` backfill (attaching the external id by
 * hand), not an automatic retry here.
 */
export async function publishDraft(
  kind: DraftKind,
  id: string,
  opts: { publisher?: Publisher; externalUrl?: string | null } = {},
): Promise<Draft> {
  const draft = await getDraft(kind, id);
  nextStatus(draft.status, "publish"); // validates the transition; throws InvalidTransitionError before any write

  if (draft.externalId) {
    // Defensive: a publish already happened (e.g. a retried action that
    // didn't see the first response). Never re-invoke the publisher.
    return draft;
  }

  const publisher = opts.publisher ?? getPublisher();

  // Hints are resolved here, not in the adapter: `isEnabled()` on adapters is
  // synchronous and must stay DB-free, so settings (async, DB-backed) are
  // read in the service and passed down. Per-draft operator choices
  // (`metadata.openlabs`) win over the `openlabs` settings defaults.
  const openlabsDefaults = await getSettings("openlabs");
  const draftHints = (draft.metadata.openlabs ?? {}) as Partial<PublishHints>;
  const hints: PublishHints = {
    type: draftHints.type ?? openlabsDefaults.defaultPostType,
    topic: draftHints.topic ?? openlabsDefaults.defaultTopic,
    tags: draftHints.tags ?? openlabsDefaults.defaultTags,
  };

  let parentExternalId: string | null = null;
  let threadExternalId: string | null = null;
  if (draft.kind === "reply") {
    parentExternalId = (await getComment(draft.commentId))?.externalId ?? null;
    threadExternalId = (await getPost(draft.postId))?.externalId ?? null;
  }

  const claimed = kind === "post" ? await claimPostForPublish(id) : await claimReplyForPublish(id);
  if (!claimed) {
    // Someone else won the race (or already published sequentially).
    const current = await getDraft(kind, id);
    throw new InvalidTransitionError("publish", current.status);
  }

  try {
    const result = await publisher.publish({
      kind,
      id,
      title: draft.kind === "post" ? draft.title : undefined,
      body: draft.body,
      parentExternalId,
      threadExternalId,
      hints,
    });
    return saveDraft(kind, id, {
      externalId: result.externalId,
      externalUrl: result.externalUrl ?? opts.externalUrl ?? null,
      metadata: { ...draft.metadata, publisher: publisher.id, openlabs: hints },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await saveDraft(kind, id, {
      status: "approved",
      publishedAt: null,
      metadata: { ...draft.metadata, lastPublishError: message, lastPublishAttemptAt: new Date().toISOString() },
    });
    throw err;
  }
}
