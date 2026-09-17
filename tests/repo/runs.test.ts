import { describe, expect, it } from "vitest";
import { appendLlmCall, appendRunStep, appendToolCall, createRun, finishRun, getRun, listRuns } from "@/lib/repo/runs";
import { useTestDb } from "../helpers/db";

describe("repo/runs", () => {
  useTestDb();

  it("creates a run with defaults", async () => {
    const run = await createRun({ workflow: "research" });
    expect(run.status).toBe("running");
    expect(run.steps).toEqual([]);
    expect(run.toolCalls).toEqual([]);
    expect(run.llmCalls).toEqual([]);
    expect(run.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(run.provider).toBeNull();
    expect(run.finishedAt).toBeNull();
  });

  it("appends steps and tool calls", async () => {
    const run = await createRun({ workflow: "research" });
    const step = { name: "plan", status: "succeeded" as const, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" };
    const call = { tool: "search", input: { q: "x" }, ok: true, durationMs: 10, at: "2026-01-01T00:00:00.500Z" };

    let updated = await appendRunStep(run.id, step);
    expect(updated.steps).toEqual([step]);

    updated = await appendToolCall(run.id, call);
    expect(updated.toolCalls).toEqual([call]);
    // steps should be unaffected by the tool-call append
    expect(updated.steps).toEqual([step]);
  });

  it("appendLlmCall accumulates usage and backfills provider/model once", async () => {
    const run = await createRun({ workflow: "chat" });
    const callA = {
      purpose: "plan",
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 500,
      at: "2026-01-01T00:00:00.000Z",
    };
    const callB = {
      purpose: "synth",
      provider: "openai",
      model: "gpt-x",
      inputTokens: 50,
      outputTokens: 5,
      durationMs: 300,
      at: "2026-01-01T00:00:01.000Z",
    };

    let updated = await appendLlmCall(run.id, callA);
    expect(updated.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(updated.provider).toBe("anthropic");
    expect(updated.model).toBe("claude-sonnet-5");

    updated = await appendLlmCall(run.id, callB);
    expect(updated.usage).toEqual({ inputTokens: 150, outputTokens: 25 });
    // provider/model were already set, so the second call must not override them
    expect(updated.provider).toBe("anthropic");
    expect(updated.model).toBe("claude-sonnet-5");
    expect(updated.llmCalls).toEqual([callA, callB]);
  });

  it("finishRun sets status, output, error and finishedAt", async () => {
    const run = await createRun({ workflow: "research" });
    const finished = await finishRun(run.id, { status: "succeeded", output: { postId: "p1" } });
    expect(finished.status).toBe("succeeded");
    expect(finished.output).toEqual({ postId: "p1" });
    expect(finished.error).toBeNull();
    expect(finished.finishedAt).not.toBeNull();
  });

  it("finishRun can record a failure with an error message", async () => {
    const run = await createRun({ workflow: "research" });
    const finished = await finishRun(run.id, { status: "failed", error: "boom" });
    expect(finished.status).toBe("failed");
    expect(finished.error).toBe("boom");
  });

  it("listRuns filters by taskId, workflow and status, newest first", async () => {
    const r1 = await createRun({ workflow: "research", taskId: null });
    const r2 = await createRun({ workflow: "chat", taskId: null });
    await finishRun(r2.id, { status: "succeeded" });

    const all = await listRuns();
    expect(all.map((r) => r.id)).toEqual([r2.id, r1.id]);

    expect((await listRuns({ workflow: "chat" })).map((r) => r.id)).toEqual([r2.id]);
    expect((await listRuns({ status: "succeeded" })).map((r) => r.id)).toEqual([r2.id]);
    expect((await getRun(r1.id))?.id).toBe(r1.id);
  });
});
