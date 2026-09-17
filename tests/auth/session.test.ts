import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  sessionCookieOptions,
  verifySessionToken,
} from "@/lib/auth/session";

const SECRET = "s".repeat(32);

describe("createSessionToken / verifySessionToken", () => {
  it("round-trips a valid token", async () => {
    const token = await createSessionToken("baran", SECRET);
    const result = await verifySessionToken(token, SECRET);
    expect(result).toEqual({ username: "baran" });
  });

  it("rejects a tampered token", async () => {
    const token = await createSessionToken("baran", SECRET);
    const lastChar = token.at(-1);
    const flipped = lastChar === "a" ? "b" : "a";
    const tampered = token.slice(0, -1) + flipped;

    const result = await verifySessionToken(tampered, SECRET);
    expect(result).toBeNull();
  });

  it("rejects an expired token", async () => {
    const issuedAt = new Date(Date.now() - (SESSION_TTL_SECONDS + 60) * 1000);
    const token = await createSessionToken("baran", SECRET, issuedAt);

    const result = await verifySessionToken(token, SECRET);
    expect(result).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken("baran", SECRET);
    const result = await verifySessionToken(token, "t".repeat(32));
    expect(result).toBeNull();
  });

  it("never throws on garbage input", async () => {
    await expect(verifySessionToken("not-a-jwt", SECRET)).resolves.toBeNull();
    await expect(verifySessionToken("", SECRET)).resolves.toBeNull();
  });
});

describe("sessionCookieOptions", () => {
  it("returns the expected defaults", () => {
    const options = sessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(SESSION_TTL_SECONDS);
  });
});

it("exports the cookie name", () => {
  expect(SESSION_COOKIE).toBe("lens_session");
});
