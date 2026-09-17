import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/auth/server";
import { listTasks } from "@/lib/repo/tasks";
import { getAgentDeps, launchInBackground } from "@/lib/workflows/runtime";
import { startResearch } from "@/lib/workflows/tasks";

/**
 * Scheduled research iteration (Vercel Cron → GET with `Authorization: Bearer $CRON_SECRET`).
 * - Skips if a research task is already in progress, so runs never pile up.
 * - A task stuck in "running" (its function timed out) is resumed from its checkpoint.
 */
export const maxDuration = 300;

const STALE_AFTER_MS = 10 * 60 * 1000;

export async function GET(request: Request) {
  if (!verifyCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const active = await listTasks({ statuses: ["queued", "running"], types: ["research"], limit: 1 });
  const deps = getAgentDeps();
  if (active.length > 0) {
    const task = active[0];
    if (task.status === "running" && Date.now() - Date.parse(task.updatedAt) > STALE_AFTER_MS) {
      launchInBackground(task.id, deps, { resume: true });
      return NextResponse.json({ resumed: true, taskId: task.id });
    }
    return NextResponse.json({ skipped: true, reason: "research already in progress", taskId: task.id });
  }
  const task = await startResearch(deps, { origin: "schedule" });
  return NextResponse.json({ started: true, taskId: task.id });
}
