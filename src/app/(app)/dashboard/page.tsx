import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  EmptyState,
  NodeStatusBadge,
  NodeTypeBadge,
  PageHeader,
  Section,
  StatusBadge,
  Tag,
  formatConfidence,
  formatDate,
} from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listPosts } from "@/lib/repo/posts";
import { listReplies } from "@/lib/repo/replies";
import { listRuns } from "@/lib/repo/runs";
import { countTasksByStatus, listTasks } from "@/lib/repo/tasks";
import { getSettings } from "@/lib/settings/service";
import { TASK_STATUSES } from "@/lib/types";
import { getKnowledgeService } from "@/lib/workflows/runtime";
import { formatDuration } from "../runs/format";
import { RunResearchForm } from "./run-research-form";

export default async function DashboardPage() {
  const k = getKnowledgeService();
  const [project, stats, taskCounts, activeTasks, recentNodes, openQuestions, awaitingPosts, awaitingReplies, runs] =
    await Promise.all([
      getSettings("project"),
      k.stats(),
      countTasksByStatus(),
      listTasks({ statuses: ["queued", "running"], limit: 20 }),
      k.listNodes({ types: ["claim", "observation", "insight"], limit: 8 }),
      k.listNodes({ types: ["question"], statuses: ["open"], limit: 8 }),
      listPosts({ statuses: ["awaiting_review"], limit: 8 }),
      listReplies({ statuses: ["awaiting_review"], limit: 8 }),
      listRuns({ limit: 8 }),
    ]);

  const hasActiveTasks = activeTasks.length > 0;

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

      <Section title="Research status" actions={<AutoRefresh enabled={hasActiveTasks} />}>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Objective</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeTasks.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="max-w-md whitespace-normal">{t.objective || "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell>{formatDate(t.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Run research">
        <RunResearchForm />
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

      <Section title="Pending approvals">
        {approvals.length === 0 ? (
          <EmptyState>Nothing awaiting review.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {approvals.map((a) => (
              <li key={`${a.kind}-${a.id}`} className="rounded-lg border p-3">
                <Link href={`/drafts/${a.kind}/${a.id}`} className="hover:underline">
                  <Tag tone="warn">{a.kind}</Tag> <span className="ml-1">{a.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Recent runs">
        {runs.length === 0 ? (
          <EmptyState>No runs yet.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Tokens in/out</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/runs/${r.id}`} className="hover:underline">
                      {r.workflow}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell>{r.model ?? "—"}</TableCell>
                  <TableCell>{formatDate(r.startedAt)}</TableCell>
                  <TableCell>{formatDuration(r.startedAt, r.finishedAt)}</TableCell>
                  <TableCell>
                    {r.usage.inputTokens} / {r.usage.outputTokens}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
