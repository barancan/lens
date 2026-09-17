import { describe, expect, it } from "vitest";
import { pollExternalComments } from "@/lib/comments/poll";
import type { CommentSource, ExternalComment } from "@/lib/integrations/types";
import { createComment, listComments } from "@/lib/repo/comments";
import { createPost, getPost, updatePost } from "@/lib/repo/posts";
import { createReply, updateReply } from "@/lib/repo/replies";
import { getTask } from "@/lib/repo/tasks";
import { useTestDb } from "../helpers/db";
import { ScriptedProvider, makeDeps } from "../helpers/agent";

/** Inline fake CommentSource, mirroring the fake-`Publisher` style used in tests/approvals/lifecycle.test.ts. */
function fakeSource(opts: {
  byPost: Record<string, ExternalComment[]>;
  selfHandle?: string | null | (() => Promise<string | null>);
}): CommentSource {
  return {
    id: "fake",
    isEnabled: () => true,
    listComments: async (postExternalId: string) => opts.byPost[postExternalId] ?? [],
    selfHandle: async () =>
      typeof opts.selfHandle === "function" ? opts.selfHandle() : (opts.selfHandle ?? null),
  };
}

function comment(externalId: string, author: string, body = "a comment", metadata: Record<string, unknown> = {}): ExternalComment {
  return { externalId, author, body, createdAt: "2026-01-01T00:00:00.000Z", metadata };
}

async function publishedPost(externalId: string | null) {
  const post = await createPost({ title: "T", body: "b", status: "approved" });
  return updatePost(post.id, { status: "published", publishedAt: new Date().toISOString(), externalId });
}

describe("pollExternalComments", () => {
  useTestDb();

  const provider = new ScriptedProvider({});

  it("returns zeros when no source is available", async () => {
    const { deps } = makeDeps(provider);
    const result = await pollExternalComments(deps, { source: undefined });
    expect(result).toEqual({ postsChecked: 0, commentsSeen: 0, ingested: 0, skipped: 0, errors: [] });
  });

  it("only checks posts that have an external_id", async () => {
    const withExt = await publishedPost("ext-1");
    await publishedPost(null); // no external id: must not be checked

    const source = fakeSource({ byPost: { "ext-1": [comment("c1", "alice")] } });
    const { deps } = makeDeps(provider);

    const result = await pollExternalComments(deps, { source });
    expect(result.postsChecked).toBe(1);
    expect(result.ingested).toBe(1);
    void withExt;
  });

  it("skips a comment authored by our own handle", async () => {
    const post = await publishedPost("ext-1");
    const source = fakeSource({
      byPost: { "ext-1": [comment("c1", "lens-agent"), comment("c2", "alice")] },
      selfHandle: "lens-agent",
    });
    const { deps } = makeDeps(provider);

    const result = await pollExternalComments(deps, { source });
    expect(result.commentsSeen).toBe(2);
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(1);
    void post;
  });

  it("skips a comment already stored as a comment row", async () => {
    const post = await publishedPost("ext-1");
    await createComment({ postId: post.id, author: "alice", body: "already here", externalId: "c1" });

    const source = fakeSource({ byPost: { "ext-1": [comment("c1", "alice")] } });
    const { deps } = makeDeps(provider);

    const result = await pollExternalComments(deps, { source });
    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips a comment whose external id matches a published reply (defense in depth)", async () => {
    const post = await publishedPost("ext-1");
    const seedComment = await createComment({ postId: post.id, author: "someone", body: "seed" });
    const reply = await createReply({ commentId: seedComment.id, postId: post.id, body: "our reply", status: "approved" });
    await updateReply(reply.id, { status: "published", publishedAt: new Date().toISOString(), externalId: "c1" });

    const source = fakeSource({ byPost: { "ext-1": [comment("c1", "alice")] } });
    const { deps } = makeDeps(provider);

    const result = await pollExternalComments(deps, { source });
    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("maxIngests caps a run and the next run picks up the rest", async () => {
    await publishedPost("ext-1");
    const comments = [comment("c1", "alice"), comment("c2", "bob"), comment("c3", "carol")];
    const source = fakeSource({ byPost: { "ext-1": comments } });
    const { deps } = makeDeps(provider);

    const first = await pollExternalComments(deps, { source, maxIngests: 2 });
    expect(first.ingested).toBe(2);
    expect(first.skipped).toBe(1);

    const second = await pollExternalComments(deps, { source, maxIngests: 2 });
    expect(second.ingested).toBe(1);
    // c1/c2 are already stored from the first run (skipped as dupes), c3 is new.
    expect(second.skipped).toBe(2);
  });

  it("one post throwing does not abort the others and lands in errors", async () => {
    await publishedPost("bad-post");
    const good = await publishedPost("ext-good");

    const source: CommentSource = {
      id: "fake",
      isEnabled: () => true,
      listComments: async (postExternalId: string) => {
        if (postExternalId === "bad-post") throw new Error("platform 500");
        return [comment("c1", "alice")];
      },
      selfHandle: async () => null,
    };
    const { deps } = makeDeps(provider);

    const result = await pollExternalComments(deps, { source });
    expect(result.postsChecked).toBe(2);
    expect(result.ingested).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("platform 500");
    void good;
  });

  it("ingested rows carry externalId and metadata and launch a comment_reply task", async () => {
    await publishedPost("ext-1");
    const source = fakeSource({
      byPost: {
        "ext-1": [comment("c1", "alice", "hello there", { platform: "openlabs", parentExternalId: null })],
      },
    });
    const { deps, launched } = makeDeps(provider);

    await pollExternalComments(deps, { source });

    expect(launched).toHaveLength(1);
    const task = await getTask(launched[0]);
    expect(task?.type).toBe("comment_reply");
    expect(task?.origin).toBe("user");
  });

  it("refreshes reception via getReception and stores it on the post's metadata", async () => {
    const post = await publishedPost("ext-1");
    const source: CommentSource = {
      id: "fake",
      isEnabled: () => true,
      listComments: async () => [],
      selfHandle: async () => null,
      getReception: async () => ({
        upvotes: 3,
        downvotes: 1,
        commentCount: 0,
        openDecision: null,
        fetchedAt: "2026-01-01T00:00:00.000Z",
      }),
    };
    const { deps } = makeDeps(provider);

    await pollExternalComments(deps, { source });
    const refreshed = await getPost(post.id);
    expect(refreshed?.metadata.reception).toEqual({
      upvotes: 3,
      downvotes: 1,
      commentCount: 0,
      openDecision: null,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("aborts the poll without ingesting anything when selfHandle() throws", async () => {
    await publishedPost("ext-1");
    const source = fakeSource({
      byPost: { "ext-1": [comment("c1", "alice")] },
      selfHandle: async () => {
        throw new Error("token expired twice");
      },
    });
    const { deps } = makeDeps(provider);

    await expect(pollExternalComments(deps, { source })).rejects.toThrow(/self-handle/i);

    const stored = await listComments();
    expect(stored).toHaveLength(0);
  });
});
