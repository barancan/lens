import { z } from "zod";

/**
 * Server-side environment. Parsed lazily so that modules can be imported in
 * tests without a full environment; each accessor validates what it needs.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  APP_USERNAME: z.string().min(1),
  APP_PASSWORD_HASH: z.string().min(1),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  CRON_SECRET: z.string().optional(),
  CONTACT_EMAIL: z.string().optional(),
  // Reserved for future Supabase features (storage/realtime); not used by the MVP data path.
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function readEnv<K extends keyof Env>(key: K): Env[K] {
  const parsed = schema.shape[key].safeParse(process.env[key]);
  if (!parsed.success) {
    throw new Error(`Invalid or missing environment variable ${key}: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data as Env[K];
}

export function requireEnv(key: keyof Env): string {
  const value = readEnv(key);
  if (!value) throw new Error(`Missing environment variable ${key}`);
  return value;
}
