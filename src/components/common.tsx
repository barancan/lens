import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DraftStatus, EvidenceType, NodeOrigin, NodeStatus, NodeType, RunStatus, TaskStatus } from "@/lib/types";

/** Small presentational helpers shared across LENS pages. Server-component safe. */

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Section({ title, children, actions, className }: { title: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cn("mb-8", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return withTime
    ? d.toLocaleString("en-GB", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"
    : d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" });
}

export function formatConfidence(c: number | null | undefined): string {
  return c === null || c === undefined ? "n/a" : c.toFixed(2);
}

type Tone = "neutral" | "good" | "bad" | "warn" | "info" | "agent";

const TONE: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  bad: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  info: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  agent: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
};

export function Tag({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <Badge variant="secondary" title={title} className={cn("font-normal", TONE[tone])}>
      {children}
    </Badge>
  );
}

const NODE_STATUS_TONE: Record<NodeStatus, Tone> = {
  open: "info",
  supported: "good",
  contested: "warn",
  weak: "bad",
  unresolved: "neutral",
  superseded: "neutral",
  answered: "good",
};

export function NodeStatusBadge({ status }: { status: NodeStatus }) {
  return <Tag tone={NODE_STATUS_TONE[status]}>{status}</Tag>;
}

export function NodeTypeBadge({ type, origin }: { type: NodeType; origin?: NodeOrigin }) {
  if (type === "insight" || origin === "agent_generated") {
    return (
      <Tag tone="agent" title="Agent-generated interpretation — not source evidence">
        {type} · agent-generated
      </Tag>
    );
  }
  return <Tag>{type}</Tag>;
}

const EVIDENCE_TONE: Record<EvidenceType, Tone> = {
  supports: "good",
  replicates: "good",
  contradicts: "bad",
  challenges: "warn",
  contextualizes: "neutral",
};

export function EvidenceTypeBadge({ type }: { type: EvidenceType }) {
  return <Tag tone={EVIDENCE_TONE[type]}>{type}</Tag>;
}

const STATUS_TONE: Record<DraftStatus | TaskStatus | RunStatus, Tone> = {
  draft: "neutral",
  awaiting_review: "warn",
  approved: "good",
  rejected: "bad",
  published: "info",
  queued: "neutral",
  running: "info",
  awaiting_approval: "warn",
  completed: "good",
  failed: "bad",
  cancelled: "neutral",
  succeeded: "good",
};

export function StatusBadge({ status }: { status: DraftStatus | TaskStatus | RunStatus }) {
  return <Tag tone={STATUS_TONE[status]}>{status.replace(/_/g, " ")}</Tag>;
}
