"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setDrillDownAction } from "../actions";

/**
 * Queues a finding for the next research cycle. The note is optional and goes
 * straight into the planner prompt, so the operator can steer the angle
 * ("check the p53 angle") rather than just flagging the node.
 */
export function DrillDownButton({
  nodeId,
  requested,
  note,
  size = "sm",
}: {
  nodeId: string;
  requested: boolean;
  note?: string | null;
  size?: "sm" | "default";
}) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const router = useRouter();

  function submit(input: { requested: boolean; note?: string }) {
    startTransition(async () => {
      const result = await setDrillDownAction(nodeId, input);
      if (result.ok) {
        toast.success(input.requested ? "Queued for the next research run" : "Removed from the drill-down queue");
        setEditing(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (requested) {
    return (
      <Button size={size} variant="outline" onClick={() => submit({ requested: false })} disabled={pending}>
        {pending ? "Removing…" : "Queued — remove"}
      </Button>
    );
  }

  if (!editing) {
    return (
      <Button size={size} variant="outline" onClick={() => setEditing(true)} disabled={pending}>
        Drill down next
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit({ requested: true, note: draft });
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="Optional steer, e.g. 'check the p53 angle'"
        className="h-8 w-64"
        maxLength={500}
      />
      <Button size="sm" onClick={() => submit({ requested: true, note: draft })} disabled={pending}>
        {pending ? "Queueing…" : "Queue"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
        Cancel
      </Button>
    </div>
  );
}
