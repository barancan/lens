import { describe, expect, it } from "vitest";
import { addMessage, createThread, deleteThread, getThread, listMessages, listThreads, renameThread } from "@/lib/repo/chat";
import { useTestDb } from "../helpers/db";

describe("repo/chat", () => {
  useTestDb();

  it("creates a thread with a default title when none is given", async () => {
    const thread = await createThread();
    expect(thread.title).toBe("New conversation");
  });

  it("creates a thread with a custom title", async () => {
    const thread = await createThread("Reprogramming and cancer risk");
    expect(thread.title).toBe("Reprogramming and cancer risk");
    expect(await getThread(thread.id)).toEqual(thread);
  });

  it("renames and deletes a thread", async () => {
    const thread = await createThread("old");
    const renamed = await renameThread(thread.id, "new");
    expect(renamed.title).toBe("new");
    expect(new Date(renamed.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(thread.updatedAt).getTime());

    await deleteThread(thread.id);
    expect(await getThread(thread.id)).toBeNull();
  });

  it("listThreads orders by updated_at desc", async () => {
    const a = await createThread("a");
    const b = await createThread("b");
    // bump a's updated_at above b's by renaming it last
    await renameThread(a.id, "a-renamed");

    const threads = await listThreads();
    expect(threads.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("addMessage stores tool calls, defaults to no run, and bumps the thread's updated_at", async () => {
    const thread = await createThread("t");
    const before = await getThread(thread.id);

    const msg = await addMessage({ threadId: thread.id, role: "user", content: "hello" });
    expect(msg.toolCalls).toEqual([]);
    expect(msg.runId).toBeNull();

    const call = { tool: "search_sources", input: { q: "OSK" }, ok: true, durationMs: 12, at: "2026-01-01T00:00:00.000Z" };
    const assistantMsg = await addMessage({ threadId: thread.id, role: "assistant", content: "hi", toolCalls: [call] });
    expect(assistantMsg.toolCalls).toEqual([call]);

    const after = await getThread(thread.id);
    expect(new Date(after!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before!.updatedAt).getTime());
  });

  it("listMessages returns oldest first", async () => {
    const thread = await createThread("t");
    const m1 = await addMessage({ threadId: thread.id, role: "user", content: "first" });
    const m2 = await addMessage({ threadId: thread.id, role: "assistant", content: "second" });

    const messages = await listMessages(thread.id);
    expect(messages.map((m) => m.id)).toEqual([m1.id, m2.id]);
  });
});
