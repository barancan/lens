/**
 * Local development database: PGlite (Postgres in WASM) with pgvector, persisted
 * to ./.pglite and exposed over the Postgres wire protocol.
 *
 *   pnpm db:local   → postgres://postgres:postgres@127.0.0.1:54322/postgres
 *
 * Migrations are applied on start.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { runMigrations } from "../src/lib/db/migrate";

const PORT = Number(process.env.PGLITE_PORT ?? 54322);
const DATA_DIR = process.env.PGLITE_DIR ?? "./.pglite";

async function main() {
  const pg = await PGlite.create({ dataDir: DATA_DIR, extensions: { vector } });
  await runMigrations(
    {
      exec: async (sql) => void (await pg.exec(sql)),
      query: async (sql, params) => (await pg.query(sql, params)).rows as never,
    },
    undefined,
    console.log,
  );
  const server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1", maxConnections: 10 });
  await server.start();
  console.log(`PGlite listening. DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`);

  const shutdown = async () => {
    await server.stop();
    await pg.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
