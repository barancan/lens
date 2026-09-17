import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireEnv } from "@/lib/env";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

/** Paths that handle their own auth and must stay reachable while logged out. */
function isPublicPath(pathname: string): boolean {
  if (pathname === "/login" || pathname === "/api/auth/login" || pathname === "/api/auth/logout") return true;
  if (pathname.startsWith("/api/cron/")) return true;
  return false;
}

/**
 * The core routing decision, kept pure of `NextRequest`/`NextResponse` so it
 * can be unit tested directly:
 * - "allow": public path, or a valid session cookie.
 * - "redirect": a protected page with no/invalid session -> send to /login.
 * - "unauthorized": a protected `/api/*` route with no/invalid session.
 */
export async function authorize(
  pathname: string,
  token: string | undefined,
  secret: string
): Promise<"allow" | "redirect" | "unauthorized"> {
  if (isPublicPath(pathname)) return "allow";

  const session = token ? await verifySessionToken(token, secret) : null;
  if (session) return "allow";

  return pathname.startsWith("/api/") ? "unauthorized" : "redirect";
}

export async function proxy(request: NextRequest): Promise<Response> {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = requireEnv("SESSION_SECRET");

  const decision = await authorize(pathname, token, secret);

  if (decision === "allow") {
    return NextResponse.next();
  }

  if (decision === "unauthorized") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff|woff2|ttf|txt|xml|json)$).*)",
  ],
};
