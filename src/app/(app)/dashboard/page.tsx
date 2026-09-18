import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  EmptyState,
  formatConfidence,
  formatDate,
  ImpactBadge,
  NodeStatusBadge,
  NodeTypeBadge,
  PageHeader,
  Section,
  StatusBadge,
  Tag,
} from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getCommentSource } from "@/lib/approvals/comment-source";
import { isOpenLabsConfigured } from "@/lib/integrations/openlabs";
import { MAX_DRILL_DOWN_QUEUE } from "@/lib/knowledge/service";
import { listPosts } from "@/lib/repo/posts";
import { listReplies } from "@/lib/repo/replies";
import { listRuns } from "@/lib/repo/runs";
import { countTasksByStatus, listTasks } from "@/lib/repo/tasks";
import { getSettings } from "@/lib/settings/service";
import { TASK_STATUSES } from "@/lib/types";
import { getKnowledgeService } from "@/lib/workflows/runtime";
import { formatDuration } from "../runs/format";
import { ContinueResearchForm } from "./continue-research-form";
import { DiscoverForm } from "./discover-form";
import { DrillDownQueue } from "./drill-down-queue";
import { PollCommentsButton } from "./poll-comments-button";
import { RunResearchForm } from "./run-research-form";

export default async function DashboardPage() {
  const k = getKnowledgeService();
  const [
    project,
    limits,
    stats,
    taskCounts,
    activeTasks,
    failedTasks,
    recentNodes,
    openQuestions,
    awaitingPosts,
    awaitingReplies,
    runs,
    drillDownQueue,
  ] = await Promise.all([
    getSettings("project"),
    getSettings("limits"),
    k.stats(),
    countTasksByStatus(),
    listTasks({ statuses: ["queued", "running"], limit: 20 }),
    listTasks({ statuses: ["failed"], limit: 5 }),
    k.listNodes({ types: ["claim", "observation", "insight"], limit: 8 }),
    k.listNodes({ types: ["question"], statuses: ["open"], limit: 8 }),
    listPosts({ statuses: ["awaiting_review"], limit: 8 }),
    listReplies({ statuses: ["awaiting_review"], limit: 8 }),
    listRuns({ limit: 8 }),
    // The whole queue: it is capped, and the operator orders it by hand.
    k.listDrillDownQueue(MAX_DRILL_DOWN_QUEUE),
  ]);

  const hasActiveTasks = activeTasks.length > 0;
  // Only render the poll button when a comment source is actually
  // configured — otherwise clicking it would always no-op.
  const canPollComments = getCommentSource() !== null;
  const openLabsConfigured = isOpenLabsConfigured();

  const statTiles: { label: string; value: number }[] = [
    { label: "Claims", value: stats.nodesByType.claim },
    { label: "Observations", value: stats.nodesByType.observation },
    { label: "Hypotheses", value: stats.nodesByType.hypothesis },
    { label: "Insights", value: stats.nodesByType.insight },
    { label: "Questions", value: stats.nodesByType.question },
    { label: "Sources", value: stats.sources },
    { label: "Evidence", value: stats.evidence },
  ];

  const approvals = [
    ...awaitingPosts.map((p) => ({ kind: "post" as const, id: p.id, label: p.title, createdAt: p.createdAt })),
    ...awaitingReplies.map((r) => ({
      kind: "reply" as const,
      id: r.id,
      label: r.body.split("\n")[0] || "(empty reply)",
      createdAt: r.createdAt,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <div>
      <PageHeader title="Dashboard" description={project.researchQuestion} />

      {project.focusDirectives.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-1.5">
          {project.focusDirectives.map((d, i) => (
            <Tag key={i} tone="info">
              {d}
            </Tag>
          ))}
        </div>
      ) : null}

      <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4 md:grid-cols-7">
        {statTiles.map((t) => (
          <div key={t.label} className="bg-card px-3 py-3">
            <div className="text-2xl font-semibold tabular-nums">{t.value}</div>
            <div className="text-xs text-muted-foreground">{t.label}</div>
          </div>
        ))}
      </div>

      {/*
        Two columns: what the operator DOES on the left, what the system is
        SAYING on the right. Stacks to one column below xl, where a rail that
        narrow stops being readable.
      */}
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <div className="min-w-0">
          {/* The two ways to start new work, side by side. */}
          <div className="mb-8 grid gap-6 md:grid-cols-2">
            <Section title="Run custom research" className="mb-0 flex flex-col">
              <RunResearchForm />
            </Section>

            <Section title="Discover on OpenLabs" className="mb-0 flex flex-col">
              <DiscoverForm configured={openLabsConfigured} />
            </Section>
          </div>

          <Section title="Continue research">
            <ContinueResearchForm queue={drillDownQueue} />
          </Section>

          <Section title="Check for comments">
            {canPollComments ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
                <PollCommentsButton />
                <span className="text-xs text-muted-foreground">
                  Pulls new comments from OpenLabs and queues replies for your review.
                </span>
              </div>
            ) : (
              <EmptyState>
                No comment source is configured. Set <code className="font-mono">OPENLABS_AGENT_CREDENTIAL</code> to
                enable this.
              </EmptyState>
            )}
          </Section>

          <Section title="Recent findings">
            {recentNodes.length === 0 ? (
              <EmptyState>No findings yet.</EmptyState>
            ) : (
              <ul className="space-y-2">
                {recentNodes.map((n) => (
                  <li key={n.id} className="rounded-lg border p-3">
                    <Link href={`/knowledge/nodes/${n.id}`} className="block hover:underline">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <NodeTypeBadge type={n.type} origin={n.origin} />
                        <NodeStatusBadge status={n.status} />
                        <span className="text-xs text-muted-foreground">confidence {formatConfidence(n.confidence)}</span>
                        <ImpactBadge impact={n.impact} title={n.impactExplanation?.reasons.join("\n")} />
                      </div>
                      <p className="text-sm">{n.statement}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Open questions">
            {openQuestions.length === 0 ? (
              <EmptyState>No open questions.</EmptyState>
            ) : (
              <ul className="space-y-2">
                {openQuestions.map((n) => (
                  <li key={n.id} className="rounded-lg border p-3">
                    <Link href={`/knowledge/nodes/${n.id}`} className="hover:underline">
                      {n.statement}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <aside className="min-w-0">
          <Section title="Research status" actions={<AutoRefresh enabled={hasActiveTasks} />}>
            {failedTasks.length > 0 ? (
              <Alert variant="destructive" className="mb-3">
                <AlertTitle>{failedTasks.length === 1 ? "1 task failed" : `${failedTasks.length} tasks failed`}</AlertTitle>
                <AlertDescription>
                  <ul className="space-y-1">
                    {failedTasks.map((t) => (
                      <li key={t.id} className="line-clamp-2">
                        <span className="font-medium">{t.objective || t.id}</span>: {t.error ?? "unknown error"}
                      </li>
                    ))}
                  </ul>
                  <Link href="/runs" className="underline">
                    Review and resume on the Runs page
                  </Link>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="mb-3 flex flex-wrap gap-1.5">
              {TASK_STATUSES.map((s) => (
                <Tag key={s} tone="neutral">
                  {s.replace(/_/g, " ")}: {taskCounts[s]}
                </Tag>
              ))}
            </div>

            {activeTasks.length === 0 ? (
              <EmptyState>No queued or running tasks.</EmptyState>
            ) : (
              <ul className="space-y-2">
                {activeTasks.map((t) => (
                  <li key={t.id} className="rounded-lg border p-3 text-sm">
                    <div className="mb-1 flex items-center gap-1.5">
                      <StatusBadge status={t.status} />
                      <span className="text-xs text-muted-foreground">{formatDate(t.createdAt)}</span>
                    </div>
                    <p className="line-clamp-3">{t.objective || "—"}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Queued for drill-down">
            <DrillDownQueue
              nodes={drillDownQueue}
              maxTargets={limits.maxDrillDownTargets}
              maxQueue={MAX_DRILL_DOWN_QUEUE}
            />
          </Section>

          <Section title="Pending approvals">
            {approvals.length === 0 ? (
              <EmptyState>Nothing awaiting review.</EmptyState>
            ) : (
              <ul className="space-y-2">
                {approvals.map((a) => (
                  <li key={`${a.kind}-${a.id}`} className="rounded-lg border p-3 text-sm">
                    <Link href={`/drafts/${a.kind}/${a.id}`} className="hover:underline">
                      <Tag tone="warn">{a.kind}</Tag> <span className="ml-1 line-clamp-2">{a.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* A compact signal, not the full table — that lives on the Runs page. */}
          <Section
            title="Recent runs"
            actions={
              <Link href="/runs" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
                View all
              </Link>
            }
          >
            {runs.length === 0 ? (
              <EmptyState>No runs yet.</EmptyState>
            ) : (
              <ul className="space-y-2">
                {runs.map((r) => (
                  <li key={r.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={r.status} />
                      <Link href={`/runs/${r.id}`} className="font-medium hover:underline">
                        {r.workflow}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(r.startedAt)} · {formatDuration(r.startedAt, r.finishedAt)}
                      </span>
                    </div>
                    {r.error ? <p className="mt-1 line-clamp-2 text-xs text-destructive">{r.error}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>
      </div>
    </div>
  );
}
