import { nextStatus } from "@/lib/approvals/lifecycle";
import { getPublisher } from "@/lib/approvals/publisher";
import type { Publisher } from "@/lib/integrations/types";
import { getComment } from "@/lib/repo/comments";
import { getPost, updatePost } from "@/lib/repo/posts";
import { getReply, updateReply } from "@/lib/repo/replies";
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
 * With the MVP manual publisher this just records that it is public.
 */
export async function publishDraft(
  kind: DraftKind,
  id: string,
  opts: { publisher?: Publisher; externalUrl?: string | null } = {},
): Promise<Draft> {
  const draft = await getDraft(kind, id);
  const status = nextStatus(draft.status, "publish");
  const publisher = opts.publisher ?? getPublisher();
  let parentExternalId: string | null = null;
  if (draft.kind === "reply") {
    parentExternalId = (await getComment(draft.commentId))?.externalId ?? null;
  }
  const result = await publisher.publish({
    kind,
    id,
    title: draft.kind === "post" ? draft.title : undefined,
    body: draft.body,
    parentExternalId,
  });
  return saveDraft(kind, id, {
    status,
    publishedAt: new Date().toISOString(),
    externalId: result.externalId,
    externalUrl: result.externalUrl ?? opts.externalUrl ?? null,
    metadata: { ...draft.metadata, publisher: publisher.id },
  });
}
