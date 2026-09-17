import { describe, expect, it } from "vitest";
import { hashPassword, verifyCredentials } from "@/lib/auth/password";

describe("verifyCredentials", () => {
  // Cost 4 is the bcrypt minimum; it keeps this test fast without weakening
  // production, which always uses hashPassword's default cost of 12.
  it("accepts the correct username and password", async () => {
    const passwordHash = await hashPassword("correct-password", 4);
    const ok = await verifyCredentials("baran", "correct-password", {
      username: "baran",
      passwordHash,
    });
    expect(ok).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const passwordHash = await hashPassword("correct-password", 4);
    const ok = await verifyCredentials("baran", "wrong-password", {
      username: "baran",
      passwordHash,
    });
    expect(ok).toBe(false);
  });

  it("rejects a wrong username", async () => {
    const passwordHash = await hashPassword("correct-password", 4);
    const ok = await verifyCredentials("someone-else", "correct-password", {
      username: "baran",
      passwordHash,
    });
    expect(ok).toBe(false);
  });
});
