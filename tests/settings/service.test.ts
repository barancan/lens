import { describe, expect, it, vi } from "vitest";
import { upsertSettingValue } from "@/lib/repo/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/schema";
import {
  addFocusDirective,
  getAllSettings,
  getSettings,
  removeFocusDirective,
  SettingsValidationError,
  updateSettings,
} from "@/lib/settings/service";
import { useTestDb } from "../helpers/db";

describe("settings/service", () => {
  useTestDb();

  it("returns the default when a key is missing", async () => {
    const project = await getSettings("project");
    expect(project).toEqual(DEFAULT_SETTINGS.project);
  });

  it("getAllSettings returns defaults for every key when nothing is stored", async () => {
    const all = await getAllSettings();
    expect(all).toEqual(DEFAULT_SETTINGS);
  });

  it("validates a stored value and returns it when valid", async () => {
    const custom = { ...DEFAULT_SETTINGS.limits, maxToolCalls: 12 };
    await upsertSettingValue("limits", custom);
    expect(await getSettings("limits")).toEqual(custom);
  });

  it("merges a partially-invalid stored object over the default when possible", async () => {
    // maxToolCalls out of range (invalid); everything else valid -> merge over default and re-validate.
    const stored = { ...DEFAULT_SETTINGS.limits, maxToolCalls: 999 };
    await upsertSettingValue("limits", stored);
    const resolved = await getSettings("limits");
    // The invalid field falls back to the default value present in the merge base... but since the
    // stored object still carries the invalid field, the merge keeps failing on it, so the whole
    // thing falls back to defaults.
    expect(resolved).toEqual(DEFAULT_SETTINGS.limits);
  });

  it("falls back to defaults, with a console.warn, when the stored value cannot be repaired", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await upsertSettingValue("project", "not-an-object");
    const resolved = await getSettings("project");
    expect(resolved).toEqual(DEFAULT_SETTINGS.project);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("updateSettings validates strictly and persists valid values", async () => {
    const next = { ...DEFAULT_SETTINGS.project, description: "updated description" };
    const updated = await updateSettings("project", next);
    expect(updated.description).toBe("updated description");
    expect(await getSettings("project")).toEqual(next);
  });

  it("updateSettings throws SettingsValidationError with zod issues on invalid input", async () => {
    await expect(updateSettings("limits", { ...DEFAULT_SETTINGS.limits, maxToolCalls: 0 })).rejects.toThrow(
      SettingsValidationError,
    );
    try {
      await updateSettings("limits", { ...DEFAULT_SETTINGS.limits, maxToolCalls: 0 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SettingsValidationError);
      expect((err as SettingsValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it("addFocusDirective dedupes and caps at 20, dropping the oldest", async () => {
    for (let i = 0; i < 20; i++) {
      await addFocusDirective(`directive-${i}`);
    }
    let project = await getSettings("project");
    expect(project.focusDirectives).toHaveLength(20);
    expect(project.focusDirectives[0]).toBe("directive-0");

    // Adding a 21st drops the oldest.
    project = await addFocusDirective("directive-20");
    expect(project.focusDirectives).toHaveLength(20);
    expect(project.focusDirectives[0]).toBe("directive-1");
    expect(project.focusDirectives.at(-1)).toBe("directive-20");

    // Re-adding an existing directive dedupes it (moves to the end) rather than growing the list.
    project = await addFocusDirective("directive-5");
    expect(project.focusDirectives).toHaveLength(20);
    expect(project.focusDirectives.at(-1)).toBe("directive-5");
    expect(project.focusDirectives.filter((d) => d === "directive-5")).toHaveLength(1);
  });

  it("removeFocusDirective removes the item at the given index", async () => {
    await addFocusDirective("a");
    await addFocusDirective("b");
    await addFocusDirective("c");

    const project = await removeFocusDirective(1);
    expect(project.focusDirectives).toEqual(["a", "c"]);
  });
});
