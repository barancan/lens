/**
 * Pure session-token helpers. No Next.js imports here so this module can be
 * used from `src/proxy.ts` (Node runtime, but a distinct module graph),
 * route handlers, server components, and tests alike.
 */
import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "lens_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  username: string;
}

/**
 * Creates a signed HS256 JWT carrying `sub` (the username), `iat` and `exp`.
 * `now` is injectable for deterministic tests.
 */
export async function createSessionToken(
  username: string,
  secret: string,
  now: Date = new Date()
): Promise<string> {
  const encodedSecret = new TextEncoder().encode(secret);
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(username)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_TTL_SECONDS)
    .sign(encodedSecret);
}

/**
 * Verifies a session token. Never throws: returns `null` for any failure
 * (bad signature, wrong secret, expired, malformed, missing subject).
 */
export async function verifySessionToken(
  token: string,
  secret: string
): Promise<{ username: string } | null> {
  try {
    const encodedSecret = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, encodedSecret, {
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }
    return { username: payload.sub };
  } catch {
    return null;
  }
}

/**
 * Only same-origin relative redirect targets ("/path") are allowed. Rejects
 * protocol-relative ("//host"), backslash ("/\host") and control-character
 * variants that browsers may treat as absolute URLs.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  if (next.includes("\\") || /[\s\p{Cc}]/u.test(next)) return fallback;
  return next;
}

/**
 * Cookie options shared by every place that sets/clears the session cookie.
 */
export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
