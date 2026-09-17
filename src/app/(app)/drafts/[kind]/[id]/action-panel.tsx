"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  approveDraftAction,
  editDraftAction,
  publishDraftAction,
  regenerateDraftAction,
  rejectDraftAction,
} from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { DraftAction } from "@/lib/approvals/lifecycle";
import { OPENLABS_TAGS, OPENLABS_TOPICS } from "@/lib/integrations/openlabs";
import { cn } from "@/lib/utils";

type Kind = "post" | "reply";
type OpenLabsPostType = "discussion" | "claim";

const MAX_TAGS = 5;

/** Server-resolved defaults/suggestions for the OpenLabs publish form — the client can't read settings or the draft's raw metadata by itself. */
export interface OpenLabsPublishDefaults {
  defaultPostType: OpenLabsPostType;
  defaultTopic: string;
  defaultTags: string[];
}

export interface OpenLabsPublishSuggestion {
  type?: OpenLabsPostType;
  topic?: string;
  tags?: string[];
}

/** Reply-only preflight: whether the platform ids a reply needs to publish are present. */
export interface ReplyPublishPreflight {
  /** The parent post's external id — required. Without it the adapter rejects the publish. */
  postExternalId: string | null;
  /** Draft id of the parent post, so we can link to its backfill form. */
  postDraftId: string;
  /** The specific comment being replied to — optional; missing just means the reply posts unthreaded. */
  commentExternalId: string | null;
}

/** Approve / edit / reject / regenerate / publish actions, gated by `availableActions(status)`. */
export function ActionPanel({
  kind,
  id,
  actions,
  initialTitle,
  initialBody,
  openLabsConfigured,
  openLabsDefaults,
  openLabsSuggestion,
  replyPreflight,
}: {
  kind: Kind;
  id: string;
  actions: DraftAction[];
  initialTitle: string | null;
  initialBody: string;
  /** Whether the OpenLabs publisher is the one that will be used (env-configured). */
  openLabsConfigured: boolean;
  openLabsDefaults: OpenLabsPublishDefaults;
  openLabsSuggestion?: OpenLabsPublishSuggestion;
  replyPreflight?: ReplyPublishPreflight;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState<DraftAction | null>(null);

  const [editTitle, setEditTitle] = React.useState(initialTitle ?? "");
  const [editBody, setEditBody] = React.useState(initialBody);
  const [rejectReason, setRejectReason] = React.useState("");
  const [feedback, setFeedback] = React.useState("");
  const [externalUrl, setExternalUrl] = React.useState("");

  const [postType, setPostType] = React.useState<OpenLabsPostType>(
    openLabsSuggestion?.type ?? openLabsDefaults.defaultPostType,
  );
  const [topic, setTopic] = React.useState(openLabsSuggestion?.topic ?? openLabsDefaults.defaultTopic);
  const [tags, setTags] = React.useState<string[]>(openLabsSuggestion?.tags ?? openLabsDefaults.defaultTags);
  const [claimFalsifiable, setClaimFalsifiable] = React.useState(false);
  const [claimCitations, setClaimCitations] = React.useState(false);

  function toggle(action: DraftAction) {
    setOpen((prev) => (prev === action ? null : action));
  }

  function toggleTag(tag: string) {
    setTags((prev) => {
      if (prev.includes(tag)) return prev.filter((t) => t !== tag);
      if (prev.length >= MAX_TAGS) return prev;
      return [...prev, tag];
    });
  }

  function approve() {
    startTransition(async () => {
      const result = await approveDraftAction(kind, id);
      if (result.ok) {
        toast.success("Approved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function submitEdit() {
    startTransition(async () => {
      const result = await editDraftAction(kind, id, {
        title: kind === "post" ? editTitle : undefined,
        body: editBody,
      });
      if (result.ok) {
        toast.success("Saved edit");
        setOpen(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function submitReject() {
    startTransition(async () => {
      const result = await rejectDraftAction(kind, id, rejectReason);
      if (result.ok) {
        toast.success("Rejected");
        setOpen(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function submitRegenerate() {
    startTransition(async () => {
      const result = await regenerateDraftAction(kind, id, feedback);
      if (result.ok) {
        toast.success("Regeneration started — running in the background");
        setOpen(null);
        setFeedback("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function submitPublish() {
    startTransition(async () => {
      const opts = openLabsConfigured
        ? kind === "post"
          ? { type: postType, topic, tags }
          : {}
        : { externalUrl: externalUrl || undefined };
      const result = await publishDraftAction(kind, id, opts);
      if (result.ok) {
        toast.success(openLabsConfigured ? "Published to OpenLabs" : "Marked as published");
        setOpen(null);
        router.refresh();
      } else {
        // ActionResult.error carries the platform's own message verbatim
        // (including 429 rate limiting), so it is surfaced as-is.
        toast.error(result.error);
      }
    });
  }

  const publishLabel = openLabsConfigured ? "Publish to OpenLabs" : "Mark as published";
  const threadMissing = kind === "reply" && openLabsConfigured && !replyPreflight?.postExternalId;
  // The type/topic/tag checklist is a deliberate reminder for the operator,
  // not a semantic check on the body — LENS cannot verify that a claim is
  // genuinely falsifiable or that citations really support it.
  const claimAckMissing =
    kind === "post" && openLabsConfigured && postType === "claim" && !(claimFalsifiable && claimCitations);
  const publishDisabled = pending || threadMissing || claimAckMissing;

  if (actions.length === 0) {
    return <p className="text-sm text-muted-foreground">No actions are available in the current status.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {actions.includes("approve") && (
          <Button size="sm" disabled={pending} onClick={approve}>
            Approve
          </Button>
        )}
        {actions.includes("edit") && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => toggle("edit")}>
            Edit
          </Button>
        )}
        {actions.includes("reject") && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => toggle("reject")}>
            Reject
          </Button>
        )}
        {actions.includes("regenerate") && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => toggle("regenerate")}>
            Regenerate
          </Button>
        )}
        {actions.includes("publish") && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => toggle("publish")}>
            {publishLabel}
          </Button>
        )}
      </div>

      <div className={cn("rounded-lg border p-4", open ? "block" : "hidden")}>
        {open === "edit" && (
          <div className="flex flex-col gap-3">
            {kind === "post" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-title">Title</Label>
                <Input id="edit-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-body">Body</Label>
              <Textarea id="edit-body" rows={10} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={pending} onClick={submitEdit}>
                Save edit
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {open === "reject" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reject-reason">Reason</Label>
              <Textarea
                id="reject-reason"
                rows={4}
                placeholder="Why is this being rejected?"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" disabled={pending} onClick={submitReject}>
                Reject
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {open === "regenerate" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="regen-feedback">Feedback for the regeneration</Label>
              <Textarea
                id="regen-feedback"
                rows={4}
                placeholder="What should change?"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={pending || !feedback.trim()} onClick={submitRegenerate}>
                Regenerate
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {open === "publish" && (
          <div className="flex flex-col gap-3">
            {openLabsConfigured ? (
              <>
                <p className="text-sm text-muted-foreground">
                  This posts publicly to OpenLabs under LENS&apos;s own agent handle. It is not undoable from LENS.
                </p>

                {kind === "reply" && (
                  <div className="flex flex-col gap-1 rounded-md border border-dashed px-3 py-2 text-sm">
                    <span>
                      Parent post linked to OpenLabs:{" "}
                      {replyPreflight?.postExternalId ? "yes" : <span className="text-destructive">no</span>}
                    </span>
                    <span className="text-muted-foreground">
                      Replying to a specific comment:{" "}
                      {replyPreflight?.commentExternalId
                        ? "yes"
                        : "no — this will post as a top-level comment on OpenLabs"}
                    </span>
                    {threadMissing && replyPreflight?.postDraftId && (
                      <span className="text-destructive">
                        This post was never linked to OpenLabs, so publishing would fail. Link it first from{" "}
                        <Link href={`/drafts/post/${replyPreflight.postDraftId}`} className="underline">
                          the post&apos;s draft page
                        </Link>
                        .
                      </span>
                    )}
                  </div>
                )}

                {kind === "post" && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="publish-type">Type</Label>
                      <select
                        id="publish-type"
                        value={postType}
                        onChange={(e) => setPostType(e.target.value as OpenLabsPostType)}
                        className="h-8 w-48 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                      >
                        <option value="discussion">discussion</option>
                        <option value="claim">claim</option>
                      </select>
                      <p className="text-sm text-muted-foreground">
                        A discussion is an open question or synthesis. A claim automatically opens a public peer
                        review on OpenLabs and is expected to state how it could be falsified and to cite real
                        sources.
                      </p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="publish-topic">Topic</Label>
                      <select
                        id="publish-topic"
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        className="h-8 w-64 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                      >
                        {OPENLABS_TOPICS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label>Tags (up to {MAX_TAGS})</Label>
                      <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                        {OPENLABS_TAGS.map((tag) => {
                          const checked = tags.includes(tag);
                          const disabled = !checked && tags.length >= MAX_TAGS;
                          return (
                            <li key={tag}>
                              <label className={`flex items-center gap-2 text-sm ${disabled ? "opacity-50" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={disabled}
                                  onChange={() => toggleTag(tag)}
                                  className="size-4 rounded border-input"
                                />
                                {tag}
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>

                    {postType === "claim" && (
                      <div className="flex flex-col gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950">
                        <p className="font-medium">Before publishing a claim — confirm, don&apos;t just check:</p>
                        {/* This checklist is a reminder for the operator, not a semantic
                            check: LENS does not (and cannot reliably) verify that the body
                            states a genuinely falsifiable test or that citations really
                            support the claim. */}
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={claimFalsifiable}
                            onChange={(e) => setClaimFalsifiable(e.target.checked)}
                            className="mt-0.5 size-4 rounded border-input"
                          />
                          <span>The body states a falsifiable test.</span>
                        </label>
                        <label className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={claimCitations}
                            onChange={(e) => setClaimCitations(e.target.checked)}
                            className="mt-0.5 size-4 rounded border-input"
                          />
                          <span>Every citation genuinely supports the claim.</span>
                        </label>
                        <p className="text-muted-foreground">
                          Publishing a claim automatically opens a public peer review on OpenLabs.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Publishing in the MVP is manual: post this on the platform yourself, then record it here so LENS
                  can track comments against it.
                </p>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="external-url">External URL (optional)</Label>
                  <Input
                    id="external-url"
                    placeholder="https://…"
                    value={externalUrl}
                    onChange={(e) => setExternalUrl(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="flex gap-2">
              <Button size="sm" disabled={publishDisabled} onClick={submitPublish}>
                {publishLabel}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
