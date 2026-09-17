/** Apply supabase/migrations/*.sql to DATABASE_URL. */
import "./load-env";
import postgres from "postgres";
import { runMigrations } from "../src/lib/db/migrate";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const ran = await runMigrations(
      {
        exec: async (text) => void (await sql.unsafe(text)),
        query: async (text, params) => (await sql.unsafe(text, (params ?? []) as never[])) as never,
      },
      undefined,
      console.log,
    );
    console.log(ran.length ? `Applied ${ran.length} migration(s).` : "Database is up to date.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
