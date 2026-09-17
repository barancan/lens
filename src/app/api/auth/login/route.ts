import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireEnv } from "@/lib/env";
import { verifyCredentials } from "@/lib/auth/password";
import { createSessionToken, safeNextPath, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  next: z.string().optional(),
});

async function parseBody(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return request.json();
  }
  if (contentType.includes("form")) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  // Unknown/missing content-type: try JSON, then fall back to form data.
  const clone = request.clone();
  try {
    return await request.json();
  } catch {
    const form = await clone.formData();
    return Object.fromEntries(form.entries());
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function invalidCredentialsResponse(): Promise<NextResponse> {
  // A fixed delay on every failure path (bad body, unknown user, wrong
  // password) avoids leaking which check failed via response timing.
  await delay(500);
  return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await parseBody(request);
  } catch {
    return invalidCredentialsResponse();
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return invalidCredentialsResponse();
  }

  const { username, password } = parsed.data;
  const ok = await verifyCredentials(username, password);
  if (!ok) {
    return invalidCredentialsResponse();
  }

  const next = safeNextPath(parsed.data.next);
  const secret = requireEnv("SESSION_SECRET");
  const token = await createSessionToken(username, secret);

  const response = NextResponse.json({ ok: true, next });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
