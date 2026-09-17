import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/login/route";
import { hashPassword } from "@/lib/auth/password";
import { SESSION_COOKIE } from "@/lib/auth/session";

const SECRET = "l".repeat(32);
const PASSWORD = "s3cret-password";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("https://example.com/api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("APP_USERNAME", "baran");
    vi.stubEnv("APP_PASSWORD_HASH", await hashPassword(PASSWORD, 4));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets a session cookie and returns ok on success", async () => {
    const response = await POST(makeRequest({ username: "baran", password: PASSWORD }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ ok: true, next: "/dashboard" });

    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toBeTruthy();
  });

  it("returns 401 for a wrong password", async () => {
    const response = await POST(makeRequest({ username: "baran", password: "wrong" }));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data).toEqual({ error: "Invalid credentials" });
  });

  it("returns 401 for a malformed body", async () => {
    const response = await POST(makeRequest({ username: "baran" }));
    expect(response.status).toBe(401);
  });

  it("sanitizes an open-redirect next back to /dashboard", async () => {
    const response = await POST(
      makeRequest({ username: "baran", password: PASSWORD, next: "https://evil.example.com/steal" })
    );
    const data = await response.json();
    expect(data.next).toBe("/dashboard");
  });

  it("sanitizes a protocol-relative next back to /dashboard", async () => {
    const response = await POST(makeRequest({ username: "baran", password: PASSWORD, next: "//evil.example.com" }));
    const data = await response.json();
    expect(data.next).toBe("/dashboard");
  });

  it("keeps a safe relative next", async () => {
    const response = await POST(makeRequest({ username: "baran", password: PASSWORD, next: "/sources/42" }));
    const data = await response.json();
    expect(data.next).toBe("/sources/42");
  });
});
