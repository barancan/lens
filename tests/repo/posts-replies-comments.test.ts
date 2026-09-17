import { describe, expect, it } from "vitest";
import {
  createComment,
  findCommentByExternalId,
  getComment,
  listComments,
  updateComment,
} from "@/lib/repo/comments";
import { createPost, getPost, listPosts, updatePost } from "@/lib/repo/posts";
import { createReply, getReply, listReplies, updateReply } from "@/lib/repo/replies";
import { useTestDb } from "../helpers/db";

describe("repo/posts", () => {
  useTestDb();

  it("creates a post with metadata and round-trips it", async () => {
    const post = await createPost({
      title: "OSK and teratoma risk",
      body: "body text",
      metadata: { rationale: "seeded from claim x", sourceIds: ["s1"] },
    });
    expect(post.status).toBe("draft");
    expect(post.metadata).toEqual({ rationale: "seeded from claim x", sourceIds: ["s1"] });

    const fetched = await getPost(post.id);
    expect(fetched).toEqual(post);
  });

  it("updatePost only touches provided keys, bumps updated_at, and round-trips metadata", async () => {
    const post = await createPost({ title: "t", body: "b" });
    await new Promise((r) => setTimeout(r, 5));

    const updated = await updatePost(post.id, {
      status: "awaiting_review",
      metadata: { rationale: "why", revisions: [{ at: "2026-01-01T00:00:00.000Z", by: "agent", body: "b" }] },
    });
    expect(updated.status).toBe("awaiting_review");
    expect(updated.title).toBe("t");
    expect(updated.metadata.rationale).toBe("why");
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(post.updatedAt).getTime());

    const approved = await updatePost(post.id, { approvedAt: updated.updatedAt, externalUrl: "https://x.test/1" });
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.externalUrl).toBe("https://x.test/1");
    expect(approved.status).toBe("awaiting_review");
  });

  it("listPosts filters by status, newest first", async () => {
    const a = await createPost({ title: "a", body: "b" });
    const b = await createPost({ title: "b", body: "b" });
    await updatePost(b.id, { status: "approved" });

    expect((await listPosts()).map((p) => p.id)).toEqual([b.id, a.id]);
    expect((await listPosts({ statuses: ["approved"] })).map((p) => p.id)).toEqual([b.id]);
    expect((await listPosts({ statuses: ["draft"] })).map((p) => p.id)).toEqual([a.id]);
  });
});

describe("repo/comments", () => {
  useTestDb();

  it("creates a comment and finds it by external id", async () => {
    const post = await createPost({ title: "t", body: "b" });
    const comment = await createComment({ postId: post.id, author: "alice", body: "great post", externalId: "ext-1" });
    expect(comment.classification).toBeNull();
    expect(comment.processedAt).toBeNull();

    const found = await findCommentByExternalId(post.id, "ext-1");
    expect(found?.id).toBe(comment.id);
    expect(await findCommentByExternalId(post.id, "missing")).toBeNull();
    expect(await getComment(comment.id)).toEqual(comment);
  });

  it("listComments returns oldest first and supports unprocessedOnly", async () => {
    const post = await createPost({ title: "t", body: "b" });
    const c1 = await createComment({ postId: post.id, author: "a", body: "1" });
    const c2 = await createComment({ postId: post.id, author: "b", body: "2" });
    await updateComment(c1.id, { classification: "question", processedAt: new Date().toISOString() });

    const all = await listComments({ postId: post.id });
    expect(all.map((c) => c.id)).toEqual([c1.id, c2.id]);

    const unprocessed = await listComments({ postId: post.id, unprocessedOnly: true });
    expect(unprocessed.map((c) => c.id)).toEqual([c2.id]);
  });

  it("updateComment patches classification, processedAt and metadata independently", async () => {
    const post = await createPost({ title: "t", body: "b" });
    const comment = await createComment({ postId: post.id, author: "a", body: "1" });

    const classified = await updateComment(comment.id, { classification: "criticism" });
    expect(classified.classification).toBe("criticism");
    expect(classified.processedAt).toBeNull();

    const processed = await updateComment(comment.id, { processedAt: "2026-01-01T00:00:00.000Z", metadata: { note: "handled" } });
    expect(processed.classification).toBe("criticism");
    expect(processed.processedAt).not.toBeNull();
    expect(processed.metadata).toEqual({ note: "handled" });
  });
});

describe("repo/replies", () => {
  useTestDb();

  it("creates, fetches, lists and updates replies with metadata round-trip", async () => {
    const post = await createPost({ title: "t", body: "b" });
    const comment = await createComment({ postId: post.id, author: "a", body: "1" });

    const reply = await createReply({
      commentId: comment.id,
      postId: post.id,
      body: "thanks for the question",
      metadata: { rationale: "cited source 1" },
    });
    expect(reply.status).toBe("draft");
    expect(await getReply(reply.id)).toEqual(reply);

    const updated = await updateReply(reply.id, { status: "approved", metadata: { rationale: "cited source 1", provider: "anthropic" } });
    expect(updated.status).toBe("approved");
    expect(updated.metadata.provider).toBe("anthropic");
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(reply.updatedAt).getTime());

    const byPost = await listReplies({ postId: post.id });
    expect(byPost.map((r) => r.id)).toEqual([reply.id]);
    const byStatus = await listReplies({ statuses: ["approved"] });
    expect(byStatus.map((r) => r.id)).toEqual([reply.id]);
    const byComment = await listReplies({ commentId: comment.id });
    expect(byComment.map((r) => r.id)).toEqual([reply.id]);
  });
});
