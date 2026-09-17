import { describe, expect, it } from "vitest";
import { createPost } from "@/lib/repo/posts";
import { ingestComment, ingestCommentTask } from "@/lib/workflows/tasks";
import { makeDeps, ScriptedProvider } from "../helpers/agent";
import { useTestDb } from "../helpers/db";

/**
 * `ingestComment`/`ingestCommentTask` are shared entry points for the chat
 * tool, the manual comment route, and (soon) the OpenLabs comment poller.
 * These tests cover the two additive changes: metadata pass-through and the
 * task-origin option (a poller needs "schedule" instead of the "user" default).
 */
describe("workflows/tasks", () => {
  useTestDb();

  async function publishedPost() {
    return createPost({ title: "Cyclic OSK update", body: "Body [1]", status: "published", metadata: { nodeIds: [] } });
  }

  it("ingestComment persists metadata onto the created comment", async () => {
    const provider = new ScriptedProvider({});
    const { deps } = makeDeps(provider);
    const post = await publishedPost();

    const { comment } = await ingestComment(deps, {
      postId: post.id,
      author: "reader",
      body: "interesting",
      externalId: "ext-1",
      metadata: { parentExternalId: "ext-parent", authorId: "u1", authorDisplayName: "Reader" },
    });

    expect(comment.metadata).toEqual({ parentExternalId: "ext-parent", authorId: "u1", authorDisplayName: "Reader" });
  });

  it("ingestCommentTask defaults to origin 'user' when no options are given", async () => {
    const provider = new ScriptedProvider({});
    const { deps } = makeDeps(provider);
    const post = await publishedPost();
    const { comment } = await ingestComment(deps, { postId: post.id, author: "reader", body: "hi" });

    const task = await ingestCommentTask(deps, comment.id);
    expect(task.origin).toBe("user");
    expect(task.objective).toBe("Respond to comment");
  });

  it("ingestCommentTask records the requested origin and objective", async () => {
    const provider = new ScriptedProvider({});
    const { deps } = makeDeps(provider);
    const post = await publishedPost();
    const { comment } = await ingestComment(deps, { postId: post.id, author: "reader", body: "hi" });

    const task = await ingestCommentTask(deps, comment.id, { origin: "schedule", objective: "Polled comment" });
    expect(task.origin).toBe("schedule");
    expect(task.objective).toBe("Polled comment");
  });
});
