import { describe, expect, it } from "vitest";
import { authorize } from "@/proxy";
import { createSessionToken } from "@/lib/auth/session";

const SECRET = "a".repeat(32);

describe("authorize", () => {
  it("allows public paths without a session", async () => {
    expect(await authorize("/login", undefined, SECRET)).toBe("allow");
    expect(await authorize("/api/auth/login", undefined, SECRET)).toBe("allow");
    expect(await authorize("/api/cron/digest", undefined, SECRET)).toBe("allow");
  });

  it("redirects protected pages when there is no valid session", async () => {
    expect(await authorize("/dashboard", undefined, SECRET)).toBe("redirect");
    expect(await authorize("/dashboard", "garbage", SECRET)).toBe("redirect");
  });

  it("returns unauthorized for protected APIs when there is no valid session", async () => {
    expect(await authorize("/api/sources", undefined, SECRET)).toBe("unauthorized");
    expect(await authorize("/api/sources", "garbage", SECRET)).toBe("unauthorized");
  });

  it("allows protected routes with a valid session token", async () => {
    const token = await createSessionToken("baran", SECRET);
    expect(await authorize("/dashboard", token, SECRET)).toBe("allow");
    expect(await authorize("/api/sources", token, SECRET)).toBe("allow");
  });

  it("does not allow a token signed with the wrong secret", async () => {
    const token = await createSessionToken("baran", "b".repeat(32));
    expect(await authorize("/dashboard", token, SECRET)).toBe("redirect");
  });
});
