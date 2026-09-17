import "server-only";

import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { readEnv, requireEnv } from "@/lib/env";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

export interface Session {
  username: string;
}

/**
 * Reads and verifies the session cookie for the current request. Returns
 * `null` when there is no session or the token is invalid/expired.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const secret = requireEnv("SESSION_SECRET");
  return verifySessionToken(token, secret);
}

/**
 * For pages and Server Actions: returns the session, or redirects to
 * `/login` if there isn't one.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

/**
 * For Route Handlers: returns `null` when authenticated, or a ready-to-return
 * 401 JSON `Response` otherwise.
 *
 * `request` is accepted so callers that already have a `NextRequest` (e.g.
 * to read the cookie without depending on the `cookies()` request-scope
 * binding, which is convenient in tests) can pass it; when omitted, the
 * cookie is read via `cookies()`.
 */
export async function requireApiSession(request?: NextRequest): Promise<Response | null> {
  const token = request ? request.cookies.get(SESSION_COOKIE)?.value : (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return unauthorized();
  }
  const secret = requireEnv("SESSION_SECRET");
  const session = await verifySessionToken(token, secret);
  if (!session) {
    return unauthorized();
  }
  return null;
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * Verifies `Authorization: Bearer <CRON_SECRET>` using a constant-time
 * comparison. Returns `false` if `CRON_SECRET` is unset (cron endpoints are
 * disabled rather than open) or the header doesn't match.
 */
export function verifyCronRequest(request: NextRequest | Request): boolean {
  const cronSecret = readEnv("CRON_SECRET");
  if (!cronSecret) return false;

  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;

  const headerBuf = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  if (headerBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(headerBuf, expectedBuf);
}
