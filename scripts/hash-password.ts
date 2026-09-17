/**
 * Hash the single application user's password for APP_PASSWORD_HASH.
 *
 *   pnpm hash-password "correct horse battery staple"
 *   pnpm hash-password < password.txt   (reads from stdin when no arg is given)
 */
import { hashPassword } from "../src/lib/auth/password";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

async function main() {
  const arg = process.argv[2];
  const password = arg ?? (await readStdin());

  if (!password) {
    console.error("Usage: pnpm hash-password <password>   (or pipe the password on stdin)");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  // Next's env file loader expands `$name`/`${name}`, so a literal `$` in the
  // hash (bcrypt hashes are full of them) must be escaped when it lands in a
  // .env.local file.
  const envEscaped = hash.replace(/\$/g, "\\$");

  console.log("bcrypt hash:");
  console.log(hash);
  console.log();
  console.log("For .env.local (`$` escaped as `\\$` so Next doesn't try to expand it):");
  console.log(`APP_PASSWORD_HASH=${envEscaped}`);
  console.log();
  console.log("Note: the Vercel dashboard's env var UI does not expand `$`, so paste the raw hash above there, not the escaped line.");
  console.log();
  console.log("To generate SESSION_SECRET (>= 32 chars), run:");
  console.log("  openssl rand -base64 48");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
