import { NextResponse } from "next/server";
import { verifyCronRequest } from "@/lib/auth/server";
import { pollExternalComments } from "@/lib/comments/poll";
import { getAgentDeps } from "@/lib/workflows/runtime";

/**
 * Scheduled comment poll (Vercel Cron → GET with `Authorization: Bearer $CRON_SECRET`).
 * Vercel Hobby allows only 2 cron jobs and daily schedules, and the research
 * cron already uses one slot, so this is the last one — a daily poll is
 * coarse. The on-demand "Check for comments" button (Wave 3) is the primary
 * path; this route is the safety net for when nobody clicks it.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const deps = getAgentDeps();
  const result = await pollExternalComments(deps);
  return NextResponse.json(result);
}
