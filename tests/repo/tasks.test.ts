import { describe, expect, it } from "vitest";
import { claimTask, countTasksByStatus, createTask, getTask, listTasks, updateTask } from "@/lib/repo/tasks";
import { useTestDb } from "../helpers/db";

describe("repo/tasks", () => {
  useTestDb();

  it("creates and fetches a task", async () => {
    const task = await createTask({ type: "research", objective: "Investigate OSK dosing", origin: "user" });
    expect(task.status).toBe("queued");
    expect(task.input).toEqual({});
    expect(task.state).toEqual({});
    expect(task.parentTaskId).toBeNull();
    expect(task.completedAt).toBeNull();

    const fetched = await getTask(task.id);
    expect(fetched).toEqual(task);
  });

  it("returns null for a missing task", async () => {
    expect(await getTask("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("lists tasks newest first, filtered by status and type, with a default limit", async () => {
    const a = await createTask({ type: "research", objective: "a", origin: "user" });
    const b = await createTask({ type: "comment_reply", objective: "b", origin: "chat" });
    await updateTask(b.id, { status: "completed" });

    const all = await listTasks();
    expect(all.map((t) => t.id)).toEqual([b.id, a.id]);

    const onlyResearch = await listTasks({ types: ["research"] });
    expect(onlyResearch.map((t) => t.id)).toEqual([a.id]);

    const onlyCompleted = await listTasks({ statuses: ["completed"] });
    expect(onlyCompleted.map((t) => t.id)).toEqual([b.id]);
  });

  it("updateTask only touches provided keys and always bumps updated_at", async () => {
    const task = await createTask({ type: "research", objective: "x", origin: "system" });
    await new Promise((r) => setTimeout(r, 5));

    const updated = await updateTask(task.id, { status: "running" });
    expect(updated.status).toBe("running");
    expect(updated.objective).toBe("x");
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(task.updatedAt).getTime());

    const withOutput = await updateTask(task.id, { output: { ok: true }, completedAt: updated.updatedAt });
    expect(withOutput.output).toEqual({ ok: true });
    expect(withOutput.status).toBe("running");
    expect(withOutput.completedAt).not.toBeNull();

    const cleared = await updateTask(task.id, { error: null });
    expect(cleared.error).toBeNull();
    expect(cleared.output).toEqual({ ok: true });
  });

  it("claimTask atomically claims and a second claim on a running task fails", async () => {
    const task = await createTask({ type: "research", objective: "claim me", origin: "user" });

    const claimed = await claimTask(task.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.error).toBeNull();

    const secondClaim = await claimTask(task.id);
    expect(secondClaim).toBeNull();

    const stillRunning = await getTask(task.id);
    expect(stillRunning?.status).toBe("running");
  });

  it("claimTask respects a custom fromStatuses list", async () => {
    const task = await createTask({ type: "research", objective: "y", origin: "user" });
    await updateTask(task.id, { status: "failed", error: "boom" });

    const claimed = await claimTask(task.id, ["failed"]);
    expect(claimed?.status).toBe("running");
    expect(claimed?.error).toBeNull();
  });

  it("countTasksByStatus tallies all statuses, including zero counts", async () => {
    await createTask({ type: "research", objective: "a", origin: "user" });
    const b = await createTask({ type: "research", objective: "b", origin: "user" });
    await updateTask(b.id, { status: "completed" });

    const counts = await countTasksByStatus();
    expect(counts.queued).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.running).toBe(0);
    expect(counts.cancelled).toBe(0);
  });
});
