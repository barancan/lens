import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { EmptyState, PageHeader, Section, StatusBadge, Tag, formatDate } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { RunStepLog } from "@/lib/types";
import { getRun } from "@/lib/repo/runs";
import { getTask } from "@/lib/repo/tasks";
import { formatDuration } from "../format";
import { ResumeButton } from "../resume-button";

const STEP_TONE: Record<RunStepLog["status"], "good" | "bad" | "neutral"> = {
  succeeded: "good",
  failed: "bad",
  skipped: "neutral",
};

export default async function RunDetailPage(props: PageProps<"/runs/[id]">) {
  const { id } = await props.params;
  const run = await getRun(id);
  if (!run) notFound();

  const task = run.taskId ? await getTask(run.taskId) : null;

  return (
    <div>
      <PageHeader
        title={run.workflow}
        description={`${run.provider ?? "—"}${run.model ? ` / ${run.model}` : ""}`}
        actions={
          <>
            <StatusBadge status={run.status} />
            <AutoRefresh enabled={run.status === "running"} />
          </>
        }
      />

      {run.error ? (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {run.error}
            {task?.status === "failed" ? (
              <div className="mt-2">
                <ResumeButton taskId={task.id} />
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <dl className="mb-8 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Started</dt>
          <dd>{formatDate(run.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Finished</dt>
          <dd>{formatDate(run.finishedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Duration</dt>
          <dd>{formatDuration(run.startedAt, run.finishedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Usage</dt>
          <dd>
            {run.usage.inputTokens} in / {run.usage.outputTokens} out
          </dd>
        </div>
        {task ? (
          <div>
            <dt className="text-xs text-muted-foreground">Task</dt>
            <dd>
              <Link href="#task" className="hover:underline">
                {task.objective || task.id}
              </Link>
            </dd>
          </div>
        ) : null}
      </dl>

      {task ? (
        <div id="task">
          <Section title="Task" actions={task.status === "failed" ? <ResumeButton taskId={task.id} /> : null}>
            <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span>{task.objective || "—"}</span>
              <StatusBadge status={task.status} />
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Input</p>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
                  {JSON.stringify(task.input, null, 2)}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Output</p>
                <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
                  {JSON.stringify(task.output, null, 2)}
                </pre>
              </div>
            </div>
          </Section>
        </div>
      ) : null}

      <Section title="Steps">
        {run.steps.length === 0 ? (
          <EmptyState>No steps recorded.</EmptyState>
        ) : (
          <ol className="space-y-2">
            {run.steps.map((s, i) => (
              <li key={i} className="rounded-md border p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  <Tag tone={STEP_TONE[s.status]}>{s.status}</Tag>
                  <span className="text-xs text-muted-foreground">{formatDuration(s.startedAt, s.finishedAt)}</span>
                </div>
                {s.summary ? <p className="mt-1 text-muted-foreground">{s.summary}</p> : null}
                {s.error ? <p className="mt-1 text-destructive">{s.error}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="LLM calls">
        {run.llmCalls.length === 0 ? (
          <EmptyState>No LLM calls recorded.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Purpose</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Tokens in/out</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.llmCalls.map((c, i) => (
                <TableRow key={i}>
                  <TableCell>{c.purpose}</TableCell>
                  <TableCell>{c.provider}</TableCell>
                  <TableCell>{c.model}</TableCell>
                  <TableCell>
                    {c.inputTokens} / {c.outputTokens}
                  </TableCell>
                  <TableCell>{(c.durationMs / 1000).toFixed(2)}s</TableCell>
                  <TableCell className="text-destructive">{c.error ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Tool calls">
        {run.toolCalls.length === 0 ? (
          <EmptyState>No tool calls recorded.</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead>OK</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.toolCalls.map((tc, i) => (
                <TableRow key={i}>
                  <TableCell>{tc.tool}</TableCell>
                  <TableCell>
                    <Tag tone={tc.ok ? "good" : "bad"}>{tc.ok ? "ok" : "failed"}</Tag>
                  </TableCell>
                  <TableCell>{(tc.durationMs / 1000).toFixed(2)}s</TableCell>
                  <TableCell>{formatDate(tc.at)}</TableCell>
                  <TableCell>
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">details</summary>
                      <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs">
                        {JSON.stringify({ input: tc.input, output: tc.output, error: tc.error }, null, 2)}
                      </pre>
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title="Output">
        <pre className="max-h-96 overflow-auto rounded-md bg-muted p-2 text-xs">
          {JSON.stringify(run.output, null, 2)}
        </pre>
      </Section>
    </div>
  );
}
