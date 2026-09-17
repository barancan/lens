import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth/session";

const SECRET = "p".repeat(32);

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy", () => {
  it("redirects unauthenticated page requests to /login with ?next=", async () => {
    const request = new NextRequest(new URL("https://example.com/dashboard"));
    const response = await proxy(request);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/dashboard");
  });

  it("returns a 401 JSON response for unauthenticated API requests", async () => {
    const request = new NextRequest(new URL("https://example.com/api/sources"));
    const response = await proxy(request);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("lets a valid session cookie through to a protected page", async () => {
    const token = await createSessionToken("baran", SECRET);
    const request = new NextRequest(new URL("https://example.com/dashboard"), {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    const response = await proxy(request);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("lets a valid session cookie through to a protected API route", async () => {
    const token = await createSessionToken("baran", SECRET);
    const request = new NextRequest(new URL("https://example.com/api/sources"), {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    const response = await proxy(request);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows the public login page and login API without a session", async () => {
    const loginPage = await proxy(new NextRequest(new URL("https://example.com/login")));
    expect(loginPage.headers.get("x-middleware-next")).toBe("1");

    const loginApi = await proxy(new NextRequest(new URL("https://example.com/api/auth/login")));
    expect(loginApi.headers.get("x-middleware-next")).toBe("1");
  });
});
