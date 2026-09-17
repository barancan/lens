import { describe, expect, it } from "vitest";
import { availableActions, InvalidTransitionError, nextStatus } from "@/lib/approvals/lifecycle";
import { approveDraft, editDraft, getDraft, publishDraft, rejectDraft } from "@/lib/approvals/service";
import type { PublishableDraft, Publisher } from "@/lib/integrations/types";
import { createComment } from "@/lib/repo/comments";
import { createPost, updatePost } from "@/lib/repo/posts";
import { createReply } from "@/lib/repo/replies";
import { useTestDb } from "../helpers/db";

describe("approval lifecycle (pure)", () => {
  it("allows only the documented transitions", () => {
    expect(nextStatus("draft", "submit")).toBe("awaiting_review");
    expect(nextStatus("awaiting_review", "approve")).toBe("approved");
    expect(nextStatus("awaiting_review", "reject")).toBe("rejected");
    expect(nextStatus("rejected", "regenerate")).toBe("awaiting_review");
    expect(nextStatus("approved", "publish")).toBe("published");
    expect(() => nextStatus("awaiting_review", "publish")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("draft", "publish")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("published", "edit")).toThrow(InvalidTransitionError);
    expect(() => nextStatus("rejected", "approve")).toThrow(InvalidTransitionError);
    expect(availableActions("published")).toEqual([]);
    expect(availableActions("awaiting_review")).toEqual(["approve", "reject", "edit", "regenerate"]);
  });
});

describe("approval service", () => {
  useTestDb();

  it("edit → approve → publish records revisions, timestamps and publisher", async () => {
    const post = await createPost({ title: "T", body: "original", status: "awaiting_review", metadata: { rationale: "r" } });
    await editDraft("post", post.id, { title: "T2", body: "edited" });
    let d = await getDraft("post", post.id);
    expect(d.body).toBe("edited");
    expect(d.kind === "post" && d.title).toBe("T2");
    expect(d.metadata.revisions?.[0]).toMatchObject({ by: "operator", body: "original" });
    expect(d.metadata.rationale).toBe("r");

    await expect(publishDraft("post", post.id)).rejects.toThrow(InvalidTransitionError);
    await approveDraft("post", post.id);
    d = await getDraft("post", post.id);
    expect(d.status).toBe("approved");
    expect(d.approvedAt).not.toBeNull();

    const publisher: Publisher = {
      id: "fake",
      isEnabled: () => true,
      publish: async () => ({ externalId: "ext-1", externalUrl: "https://platform.example/p/1" }),
    };
    d = await publishDraft("post", post.id, { publisher });
    expect(d.status).toBe("published");
    expect(d.externalId).toBe("ext-1");
    expect(d.metadata.publisher).toBe("fake");
  });

  it("rejects replies with a reason and never publishes unapproved drafts", async () => {
    const post = await createPost({ title: "T", body: "b", status: "published" });
    const comment = await createComment({ postId: post.id, author: "a", body: "c" });
    const reply = await createReply({ commentId: comment.id, postId: post.id, body: "r", status: "awaiting_review" });
    await rejectDraft("reply", reply.id, "too assertive");
    const d = await getDraft("reply", reply.id);
    expect(d.status).toBe("rejected");
    expect(d.metadata.rejectionReason).toBe("too assertive");
    await expect(publishDraft("reply", reply.id)).rejects.toThrow(InvalidTransitionError);
    await expect(approveDraft("reply", reply.id)).rejects.toThrow(InvalidTransitionError);
  });

  it("resolves openlabs hints from settings, with per-draft metadata taking precedence", async () => {
    const post = await createPost({
      title: "T",
      body: "b",
      status: "approved",
      metadata: { openlabs: { tags: ["genomics-research"] } },
    });

    let received: PublishableDraft | undefined;
    const publisher: Publisher = {
      id: "openlabs",
      isEnabled: () => true,
      publish: async (draft) => {
        received = draft;
        return { externalId: "post-9", externalUrl: null };
      },
    };
    await publishDraft("post", post.id, { publisher });

    // Defaults come from the `openlabs` settings key...
    expect(received?.hints?.type).toBe("discussion");
    expect(received?.hints?.topic).toBe("biology-life-sciences");
    // ...but the operator's per-draft choice overrides the default.
    expect(received?.hints?.tags).toEqual(["genomics-research"]);
  });

  it("resolves both parentExternalId and threadExternalId for a reply publish", async () => {
    const post = await createPost({ title: "T", body: "b", status: "published" });
    await updatePost(post.id, { externalId: "post-ext-1" });
    const comment = await createComment({ postId: post.id, author: "a", body: "c", externalId: "comment-ext-1" });
    const reply = await createReply({ commentId: comment.id, postId: post.id, body: "r", status: "approved" });

    let received: PublishableDraft | undefined;
    const publisher: Publisher = {
      id: "openlabs",
      isEnabled: () => true,
      publish: async (draft) => {
        received = draft;
        return { externalId: "reply-ext-1", externalUrl: null };
      },
    };
    await publishDraft("reply", reply.id, { publisher });

    expect(received?.parentExternalId).toBe("comment-ext-1");
    expect(received?.threadExternalId).toBe("post-ext-1");
  });

  it("rolls back to approved with lastPublishError set when the publisher fails", async () => {
    const post = await createPost({ title: "T", body: "b", status: "approved" });
    const publisher: Publisher = {
      id: "openlabs",
      isEnabled: () => true,
      publish: async () => {
        throw new Error("platform exploded");
      },
    };

    await expect(publishDraft("post", post.id, { publisher })).rejects.toThrow("platform exploded");

    const d = await getDraft("post", post.id);
    expect(d.status).toBe("approved");
    expect(d.publishedAt).toBeNull();
    expect(d.metadata.lastPublishError).toBe("platform exploded");
    expect(typeof d.metadata.lastPublishAttemptAt).toBe("string");
    // The row was not left dangling as "published" without an external id.
    expect(d.externalId).toBeNull();
  });

  it("throws InvalidTransitionError when publishing an already-published draft", async () => {
    const post = await createPost({ title: "T", body: "b", status: "published" });
    await expect(publishDraft("post", post.id)).rejects.toThrow(InvalidTransitionError);
  });

  it("lets exactly one of two concurrent publishDraft calls invoke the publisher (CAS claim)", async () => {
    const post = await createPost({ title: "T", body: "b", status: "approved" });

    let callCount = 0;
    const publisher: Publisher = {
      id: "openlabs",
      isEnabled: () => true,
      publish: async () => {
        callCount += 1;
        // Give the second concurrent call a chance to race the first before either finishes.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { externalId: "post-race-1", externalUrl: null };
      },
    };

    const outcomes = await Promise.all([
      publishDraft("post", post.id, { publisher })
        .then((d) => ({ ok: true as const, d }))
        .catch((e: unknown) => ({ ok: false as const, e })),
      publishDraft("post", post.id, { publisher })
        .then((d) => ({ ok: true as const, d }))
        .catch((e: unknown) => ({ ok: false as const, e })),
    ]);

    expect(callCount).toBe(1);
    const fulfilled = outcomes.filter((o) => o.ok);
    const rejected = outcomes.filter((o) => !o.ok);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { ok: false; e: unknown }).e).toBeInstanceOf(InvalidTransitionError);

    const d = await getDraft("post", post.id);
    expect(d.status).toBe("published");
    expect(d.externalId).toBe("post-race-1");
  });
});
