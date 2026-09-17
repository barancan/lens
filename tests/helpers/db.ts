/**
 * Real Postgres (PGlite + pgvector) for tests, served over the wire protocol so
 * the production postgres.js code path is exercised unchanged.
 *
 *   const testDb = useTestDb();   // in a describe/file scope
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { setDb, type Sql } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

const TABLES = [
  "chat_messages",
  "chat_threads",
  "replies",
  "comments",
  "posts",
  "evidence",
  "knowledge_edges",
  "knowledge_node_history",
  "knowledge_nodes",
  "source_chunks",
  "sources",
  "agent_runs",
  "tasks",
  "agent_settings",
];

export interface TestDb {
  sql: Sql;
}

export function useTestDb(): TestDb {
  const handle = {} as TestDb;
  let pg: PGlite;
  let server: PGLiteSocketServer;

  beforeAll(async () => {
    pg = await PGlite.create({ extensions: { vector } });
    await runMigrations({
      exec: async (sql) => void (await pg.exec(sql)),
      query: async (sql, params) => (await pg.query(sql, params)).rows as never,
    });
    const port = 20000 + Math.floor(Math.random() * 20000);
    server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1" });
    await server.start();
    handle.sql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    setDb(handle.sql);
  }, 60_000);

  beforeEach(async () => {
    await handle.sql.unsafe(`truncate ${TABLES.join(", ")} restart identity cascade`);
  });

  afterAll(async () => {
    setDb(null);
    await handle.sql?.end();
    await server?.stop();
    await pg?.close();
  });

  return handle;
}

/** Deterministic pseudo-embedding: bag-of-words hashed into 1536 dims, L2-normalised. */
export function fakeEmbedding(text: string, dims = 1536): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % dims] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
