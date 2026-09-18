"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EmptyState, ImpactBadge, NodeStatusBadge, NodeTypeBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import type { KnowledgeNode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { researchQueuedFindingAction } from "../actions";

/**
 * Starts a research run on a finding already in the drill-down queue, rather
 * than waiting for a cycle to reach it. Picking one also moves it to the front
 * of the queue — see `researchQueuedFindingAction` for why.
 */
export function ContinueResearchForm({ queue }: { queue: KnowledgeNode[] }) {
  const [selected, setSelected] = useState<string | null>(queue[0]?.id ?? null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // The queue can change under us — a run consumes entries, and the rail lets
  // you remove them — so a stale selection would submit an id that is no longer
  // queued and fail. Fall back to the top of the list instead.
  const validSelection = selected !== null && queue.some((n) => n.id === selected);
  const active = validSelection ? selected : (queue[0]?.id ?? null);

  if (queue.length === 0) {
    return (
      <EmptyState>
        Nothing queued. Open a finding in{" "}
        <Link href="/knowledge" className="underline">
          Knowledge
        </Link>{" "}
        and choose <strong>Drill down next</strong>.
      </EmptyState>
    );
  }

  function submit() {
    if (!active) return;
    startTransition(async () => {
      const result = await researchQueuedFindingAction(active);
      if (result.ok) {
        toast.success("Research launched on that finding", {
          description: "It runs in the background; progress appears on the Runs page.",
          action: { label: "View runs", onClick: () => router.push("/runs") },
        });
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">
        Pick a queued finding and research it now. It also moves to the front of the queue, so the run targets it first.
      </p>

      <fieldset className="space-y-2" disabled={pending}>
        <legend className="sr-only">Queued findings</legend>
        {queue.map((n) => (
          <label
            key={n.id}
            className={cn(
              "flex cursor-pointer gap-2 rounded-md border p-2 text-sm transition-colors",
              active === n.id ? "border-primary bg-accent" : "hover:bg-muted/50",
            )}
          >
            <input
              type="radio"
              name="queued-finding"
              value={n.id}
              checked={active === n.id}
              onChange={() => setSelected(n.id)}
              className="mt-1 shrink-0"
            />
            <span className="min-w-0">
              <span className="mb-1 flex flex-wrap items-center gap-1.5">
                <NodeTypeBadge type={n.type} origin={n.origin} />
                <NodeStatusBadge status={n.status} />
                <ImpactBadge impact={n.impact} title={n.impactExplanation?.reasons.join("\n")} />
              </span>
              <span className="line-clamp-2 block">{n.statement}</span>
              {n.drillDownNote ? (
                <span className="mt-0.5 block text-xs text-muted-foreground">Your steer: &ldquo;{n.drillDownNote}&rdquo;</span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>

      <Button onClick={submit} disabled={pending || !active}>
        {pending ? "Launching…" : "Research this now"}
      </Button>
    </div>
  );
}
