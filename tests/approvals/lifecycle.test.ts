import { describe, expect, it } from "vitest";
import { availableActions, InvalidTransitionError, nextStatus } from "@/lib/approvals/lifecycle";
import { approveDraft, editDraft, getDraft, publishDraft, rejectDraft } from "@/lib/approvals/service";
import type { Publisher } from "@/lib/integrations/types";
import { createComment } from "@/lib/repo/comments";
import { createPost } from "@/lib/repo/posts";
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
});
