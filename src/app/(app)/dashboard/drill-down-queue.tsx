"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EmptyState, ImpactBadge, NodeStatusBadge, NodeTypeBadge, Tag, formatDate } from "@/components/common";
import { Button } from "@/components/ui/button";
import type { KnowledgeNode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { reorderDrillDownQueueAction, setDrillDownAction } from "../actions";

/**
 * Fixed row height, so "three items tall" is exact rather than dependent on how
 * long a statement happens to be. Content that does not fit is clamped.
 */
const ITEM_HEIGHT_REM = 7;
const GAP_REM = 0.5;
const VISIBLE_ITEMS = 3;

function move<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The operator's drill-down shortlist, reorderable by dragging.
 *
 * Order is persisted rather than derived: impact can change under the
 * operator's feet when a run rescores, so once they have arranged the queue it
 * stays arranged. Reordering is optimistic — the list moves immediately and the
 * server action reconciles, reverting on failure.
 */
export function DrillDownQueue({
  nodes,
  maxTargets,
  maxQueue,
}: {
  nodes: KnowledgeNode[];
  maxTargets: number;
  maxQueue: number;
}) {
  const [items, setItems] = useState(nodes);
  const [lastNodes, setLastNodes] = useState(nodes);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  // The server is the source of truth: adopt its order whenever the page
  // revalidates. Adjusted during render rather than in an effect, so the list
  // never paints one frame of stale order.
  if (nodes !== lastNodes) {
    setLastNodes(nodes);
    setItems(nodes);
  }

  function persist(next: KnowledgeNode[], previous: KnowledgeNode[], focusId?: string) {
    setItems(next);
    startTransition(async () => {
      const result = await reorderDrillDownQueueAction(next.map((n) => n.id));
      if (result.ok) {
        router.refresh();
        if (focusId) {
          // Keep the keyboard on the row that just moved.
          requestAnimationFrame(() => {
            const i = next.findIndex((n) => n.id === focusId);
            rowRefs.current[i]?.focus();
          });
        }
      } else {
        setItems(previous);
        toast.error(result.error);
      }
    });
  }

  function reorder(from: number, to: number, focusId?: string) {
    if (from === to || to < 0 || to >= items.length) return;
    persist(move(items, from, to), items, focusId);
  }

  function remove(id: string) {
    startTransition(async () => {
      const result = await setDrillDownAction(id, { requested: false });
      if (result.ok) {
        setItems((current) => current.filter((n) => n.id !== id));
        toast.success("Removed from the drill-down queue");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (items.length === 0) {
    return (
      <EmptyState>
        Nothing queued. Open a finding in{" "}
        <Link href="/knowledge" className="underline">
          Knowledge
        </Link>{" "}
        and choose <strong>Drill down next</strong> — the next research run will target it.
      </EmptyState>
    );
  }

  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">
        Drag to reorder — the next run takes the top {Math.min(maxTargets, items.length)}, in this order. Any run counts,
        including the nightly cron. {items.length} of {maxQueue} slots used.
      </p>

      <ul
        className="space-y-2 overflow-y-auto pr-1"
        style={{ maxHeight: `${VISIBLE_ITEMS * ITEM_HEIGHT_REM + (VISIBLE_ITEMS - 1) * GAP_REM}rem` }}
      >
        {items.map((n, i) => (
          <li
            key={n.id}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            tabIndex={0}
            aria-label={`Queue position ${i + 1} of ${items.length}: ${n.statement}`}
            draggable={!pending}
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOver(i);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging !== null) reorder(dragging, i);
              setDragging(null);
              setOver(null);
            }}
            // Native drag-and-drop is mouse-only, so the same reordering is
            // available from the keyboard once a row has focus.
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" && (e.metaKey || e.altKey)) {
                e.preventDefault();
                reorder(i, i - 1, n.id);
              }
              if (e.key === "ArrowDown" && (e.metaKey || e.altKey)) {
                e.preventDefault();
                reorder(i, i + 1, n.id);
              }
            }}
            style={{ height: `${ITEM_HEIGHT_REM}rem` }}
            className={cn(
              "flex cursor-grab gap-2 overflow-hidden rounded-lg border p-3 transition-colors",
              "focus:ring-2 focus:ring-ring focus:outline-none",
              dragging === i && "cursor-grabbing opacity-50",
              over === i && dragging !== null && dragging !== i && "border-primary bg-accent",
              i >= maxTargets && "opacity-60",
            )}
          >
            <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5 text-muted-foreground">
              <span aria-hidden className="text-sm leading-none select-none">
                ⠿
              </span>
              <span className="text-xs tabular-nums">{i + 1}</span>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <NodeTypeBadge type={n.type} origin={n.origin} />
                <NodeStatusBadge status={n.status} />
                <ImpactBadge impact={n.impact} title={n.impactExplanation?.reasons.join("\n")} />
                {i >= maxTargets ? <Tag tone="neutral">waits for a later run</Tag> : null}
                <span className="text-xs text-muted-foreground">queued {formatDate(n.drillDownRequestedAt)}</span>
              </div>

              <Link href={`/knowledge/nodes/${n.id}`} className="line-clamp-2 text-sm hover:underline">
                {n.statement}
              </Link>
              {n.drillDownNote ? (
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  Your steer: &ldquo;{n.drillDownNote}&rdquo;
                </p>
              ) : null}
            </div>

            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 self-start"
              onClick={() => remove(n.id)}
              disabled={pending}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
