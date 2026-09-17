import postgres from "postgres";
import { requireEnv } from "@/lib/env";

export type Sql = postgres.Sql;

let client: Sql | null = null;

function isLocal(url: string): boolean {
  return /@(localhost|127\.0\.0\.1)[:/]/.test(url);
}

/**
 * Shared Postgres client. Only `src/lib/repo/*` (and scripts) should import this.
 * - Supabase: use the transaction pooler URL; prepared statements are disabled.
 * - Local PGlite socket server: a single connection.
 */
export function db(): Sql {
  if (!client) {
    const url = requireEnv("DATABASE_URL");
    client = postgres(url, {
      max: isLocal(url) ? 1 : 5,
      prepare: false,
      idle_timeout: 20,
      onnotice: () => {},
    });
  }
  return client;
}

/** Test/scripts hook: replace the shared client. */
export function setDb(sql: Sql | null): void {
  client = sql;
}

/** pgvector literal for a JS number array. */
export function toVector(embedding: number[] | null | undefined): string | null {
  return embedding ? `[${embedding.join(",")}]` : null;
}
