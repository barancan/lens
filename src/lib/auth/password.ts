/**
 * Password verification for the single application user. Pure (no
 * Next.js/server-only imports) so it can run in tests and scripts.
 */
import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "node:crypto";
import { requireEnv } from "@/lib/env";

export interface Credentials {
  username: string;
  passwordHash: string;
}

function defaultCredentials(): Credentials {
  return {
    username: requireEnv("APP_USERNAME"),
    passwordHash: requireEnv("APP_PASSWORD_HASH"),
  };
}

/** Constant-time string comparison via SHA-256 digests of equal length. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Verifies a username/password pair against the configured single-user
 * credentials. Always runs the bcrypt comparison, even when the username is
 * already known to be wrong, so failure timing doesn't leak which check
 * failed.
 */
export async function verifyCredentials(
  username: string,
  password: string,
  cfg: Credentials = defaultCredentials()
): Promise<boolean> {
  const usernameMatches = timingSafeStringEqual(username, cfg.username);
  const passwordMatches = await bcrypt.compare(password, cfg.passwordHash);
  return usernameMatches && passwordMatches;
}

/** Hashes a password with bcrypt. Default cost 12; tests may lower it. */
export async function hashPassword(pw: string, cost = 12): Promise<string> {
  return bcrypt.hash(pw, cost);
}
