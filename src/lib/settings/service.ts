import "server-only";
import type { z } from "zod";
import { getAllSettingValues, getSettingValue, upsertSettingValue } from "@/lib/repo/settings";
import { DEFAULT_SETTINGS, SETTINGS_KEYS, settingsSchemas, type Settings, type SettingsKey } from "./schema";

/** Thrown by `updateSettings` when the provided value fails strict schema validation. */
export class SettingsValidationError extends Error {
  readonly key: string;
  readonly issues: z.core.$ZodIssue[];

  constructor(key: string, issues: z.core.$ZodIssue[]) {
    super(`Invalid settings for "${key}": ${issues.map((i) => i.message).join("; ")}`);
    this.name = "SettingsValidationError";
    this.key = key;
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a raw stored value against a key's schema, falling back to (or merging with) defaults. */
function resolveSetting<K extends SettingsKey>(key: K, raw: unknown): Settings[K] {
  const schema = settingsSchemas[key];
  const fallback = DEFAULT_SETTINGS[key];
  if (raw === null || raw === undefined) return fallback;

  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data as Settings[K];

  if (isPlainObject(raw)) {
    const merged = { ...(fallback as Record<string, unknown>), ...raw };
    const mergedParsed = schema.safeParse(merged);
    if (mergedParsed.success) return mergedParsed.data as Settings[K];
  }

  console.warn(`Invalid stored settings for "${key}"; falling back to defaults.`, parsed.error.issues);
  return fallback;
}

export async function getSettings<K extends SettingsKey>(key: K): Promise<Settings[K]> {
  const raw = await getSettingValue(key);
  return resolveSetting(key, raw);
}

export async function getAllSettings(): Promise<Settings> {
  const all = await getAllSettingValues();
  const entries = SETTINGS_KEYS.map((key) => [key, resolveSetting(key, all[key] ?? null)] as const);
  return Object.fromEntries(entries) as Settings;
}

/** Strict validation: throws `SettingsValidationError` (with zod issues) on failure. */
export async function updateSettings<K extends SettingsKey>(key: K, value: unknown): Promise<Settings[K]> {
  const schema = settingsSchemas[key];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SettingsValidationError(key, parsed.error.issues);
  }
  await upsertSettingValue(key, parsed.data);
  return parsed.data as Settings[K];
}

const MAX_FOCUS_DIRECTIVES = 20;

/** Appends a focus directive, de-duplicated and capped, dropping the oldest when over the cap. */
export async function addFocusDirective(text: string): Promise<Settings["project"]> {
  const current = await getSettings("project");
  const deduped = current.focusDirectives.filter((d) => d !== text);
  const focusDirectives = [...deduped, text].slice(-MAX_FOCUS_DIRECTIVES);
  return updateSettings("project", { ...current, focusDirectives });
}

export async function removeFocusDirective(index: number): Promise<Settings["project"]> {
  const current = await getSettings("project");
  const focusDirectives = current.focusDirectives.filter((_, i) => i !== index);
  return updateSettings("project", { ...current, focusDirectives });
}
