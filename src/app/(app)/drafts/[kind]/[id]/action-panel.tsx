"use client";

import * as React from "react";
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
import { cn } from "@/lib/utils";

type Kind = "post" | "reply";

/** Approve / edit / reject / regenerate / publish actions, gated by `availableActions(status)`. */
export function ActionPanel({
  kind,
  id,
  actions,
  initialTitle,
  initialBody,
}: {
  kind: Kind;
  id: string;
  actions: DraftAction[];
  initialTitle: string | null;
  initialBody: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [open, setOpen] = React.useState<DraftAction | null>(null);

  const [editTitle, setEditTitle] = React.useState(initialTitle ?? "");
  const [editBody, setEditBody] = React.useState(initialBody);
  const [rejectReason, setRejectReason] = React.useState("");
  const [feedback, setFeedback] = React.useState("");
  const [externalUrl, setExternalUrl] = React.useState("");

  function toggle(action: DraftAction) {
    setOpen((prev) => (prev === action ? null : action));
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
      const result = await publishDraftAction(kind, id, externalUrl || undefined);
      if (result.ok) {
        toast.success("Marked as published");
        setOpen(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

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
            Mark as published
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
            <p className="text-sm text-muted-foreground">
              Publishing in the MVP is manual: post this on the platform yourself, then record it here so LENS can
              track comments against it.
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
            <div className="flex gap-2">
              <Button size="sm" disabled={pending} onClick={submitPublish}>
                Mark as published
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
