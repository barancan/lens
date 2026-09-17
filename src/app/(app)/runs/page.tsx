import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { EmptyState, PageHeader, Section, StatusBadge, formatDate } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listRuns } from "@/lib/repo/runs";
import { getTask, listTasks } from "@/lib/repo/tasks";
import { formatDuration, isStaleRunning } from "./format";
import { ResumeButton } from "./resume-button";

export default async function RunsPage() {
  const [tasks, runs] = await Promise.all([
    listTasks({ statuses: ["queued", "running", "failed"], limit: 50 }),
    listRuns({ limit: 50 }),
  ]);

  const taskIds = Array.from(new Set(runs.map((r) => r.taskId).filter((id): id is string => id !== null)));
  const fetchedTasks = await Promise.all(taskIds.map((id) => getTask(id)));
  const taskById = new Map(fetchedTasks.filter((t) => t !== null).map((t) => [t.id, t]));

  const anyRunning = runs.some((r) => r.status === "running");

  return (
    <div>
      <PageHeader title="Runs" actions={<AutoRefresh enabled={anyRunning} />} />

      <Section title="Tasks needing attention">
        {tasks.length === 0 ? (
          <EmptyState>No queued, running or failed tasks.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Objective</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => {
                const canResume = t.status === "failed" || (t.status === "running" && isStaleRunning(t.updatedAt));
                return (
                  <TableRow key={t.id}>
                    <TableCell className="max-w-md whitespace-normal">{t.objective || "—"}</TableCell>
                    <TableCell>{t.type}</TableCell>
                    <TableCell>
                      <StatusBadge status={t.status} />
                    </TableCell>
                    <TableCell>{formatDate(t.createdAt)}</TableCell>
                    <TableCell>{formatDate(t.updatedAt)}</TableCell>
                    <TableCell>{canResume ? <ResumeButton taskId={t.id} /> : null}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
                <TableHead>Provider / model</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Tokens in/out</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => {
                const task = r.taskId ? taskById.get(r.taskId) : undefined;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/runs/${r.id}`} className="hover:underline">
                        {r.workflow}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell>
                      {r.provider ?? "—"}
                      {r.model ? ` / ${r.model}` : ""}
                    </TableCell>
                    <TableCell className="max-w-xs truncate">{task?.objective ?? "—"}</TableCell>
                    <TableCell>{formatDate(r.startedAt)}</TableCell>
                    <TableCell>{formatDuration(r.startedAt, r.finishedAt)}</TableCell>
                    <TableCell>
                      {r.usage.inputTokens} / {r.usage.outputTokens}
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-destructive">{r.error ?? ""}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
