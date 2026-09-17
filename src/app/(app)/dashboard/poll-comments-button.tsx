"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { pollCommentsAction } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";

/**
 * On-demand comment pull — the primary path for pulling comments in from
 * OpenLabs. Vercel Hobby only allows a daily cron, so the cron route
 * (`/api/cron/comments`) is just the safety net; this button is how comments
 * actually get checked in practice. Only rendered when a comment source is
 * configured (see the dashboard page), since otherwise it would always no-op.
 */
export function PollCommentsButton() {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function check() {
    startTransition(async () => {
      const result = await pollCommentsAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const { postsChecked, ingested, errors } = result.data ?? { postsChecked: 0, ingested: 0, errors: [] };
      const summary = `${postsChecked} post${postsChecked === 1 ? "" : "s"} checked, ${ingested} new comment${ingested === 1 ? "" : "s"} ingested`;
      if (errors.length > 0) {
        toast.error(`${summary} — ${errors.length} error${errors.length === 1 ? "" : "s"}`, {
          description: errors.map((e) => e.error).join("; "),
        });
      } else {
        toast.success(summary);
      }
      router.refresh();
    });
  }

  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={check}>
      {pending ? "Checking…" : "Check for comments"}
    </Button>
  );
}
