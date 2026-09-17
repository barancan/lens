import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Minimal executor so migrations can run on postgres.js or PGlite directly. */
export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

export async function runMigrations(
  executor: SqlExecutor,
  dir: string = MIGRATIONS_DIR,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  await executor.exec(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const applied = new Set(
    (await executor.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    await executor.exec(`begin;\n${sql}\n;insert into schema_migrations (name) values ('${file.replace(/'/g, "''")}');\ncommit;`);
    ran.push(file);
    log(`applied ${file}`);
  }
  return ran;
}
