import { db } from "@/lib/db/client";

/** Raw key/value access to `agent_settings`. No schema validation here — see `src/lib/settings/service.ts`. */

export async function getSettingValue(key: string): Promise<unknown | null> {
  const sql = db();
  const [row] = await sql<{ value: unknown }[]>`select value from agent_settings where key = ${key}`;
  return row ? row.value : null;
}

export async function getAllSettingValues(): Promise<Record<string, unknown>> {
  const sql = db();
  const rows = await sql<{ key: string; value: unknown }[]>`select key, value from agent_settings`;
  const result: Record<string, unknown> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export async function upsertSettingValue(key: string, value: unknown): Promise<void> {
  const sql = db();
  await sql`
    insert into agent_settings (key, value)
    values (${key}, ${sql.json(value as never)})
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}
