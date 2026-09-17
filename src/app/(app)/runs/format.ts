/** Shared formatting/staleness helpers for the runs list and run detail pages. */

const STALE_RUNNING_MS = 15 * 60 * 1000;

/** A "running" task that hasn't been touched in a while is probably stuck and safe to resume. */
export function isStaleRunning(updatedAt: string): boolean {
  return Date.now() - new Date(updatedAt).getTime() > STALE_RUNNING_MS;
}

export function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "running…";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
