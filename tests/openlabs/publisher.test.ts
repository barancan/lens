import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOpenLabsAuth } from "@/lib/integrations/openlabs/auth";
import { OpenLabsError } from "@/lib/integrations/openlabs/errors";
import { OpenLabsPublisher } from "@/lib/integrations/openlabs/publisher";
import type { PublishableDraft } from "@/lib/integrations/types";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("OpenLabsPublisher", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let publisher: OpenLabsPublisher;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENLABS_AGENT_CREDENTIAL", "cred-123");
    resetOpenLabsAuth();
    publisher = new OpenLabsPublisher();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetOpenLabsAuth();
  });

  describe("isEnabled", () => {
    it("is false without the credential", () => {
      vi.unstubAllEnvs();
      expect(new OpenLabsPublisher().isEnabled()).toBe(false);
    });

    it("is true with the credential", () => {
      expect(new OpenLabsPublisher().isEnabled()).toBe(true);
    });
  });

  describe("publishing a post", () => {
    function postDraft(overrides: Partial<PublishableDraft> = {}): PublishableDraft {
      return {
        kind: "post",
        id: "draft-1",
        title: "A title",
        body: "Some body",
        hints: { type: "discussion", topic: "biology-life-sciences", tags: ["aging", "longevity"] },
        ...overrides,
      };
    }

    it("POSTs to /api/v1/posts with the exact expected body and returns the derived public URL", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
        .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ id: "post-1" }, 201));

      const result = await publisher.publish(postDraft());

      expect(result).toEqual({ externalId: "post-1", externalUrl: "https://openlabs.bio.xyz/post/post-1" });
      const [url, init] = fetchMock.mock.calls[2];
      expect(url).toBe("https://api.openlabs.bio.xyz/api/v1/posts");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        type: "discussion",
        title: "A title",
        body: "Some body",
        topic: "biology-life-sciences",
        tags: ["aging", "longevity"],
      });
    });

    it("drops unknown tags", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
        .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ id: "post-1" }, 201));

      await publisher.publish(postDraft({ hints: { type: "discussion", topic: "biology-life-sciences", tags: ["aging", "not-a-real-tag"] } }));

      const [, init] = fetchMock.mock.calls[2];
      expect(JSON.parse(init.body).tags).toEqual(["aging"]);
    });

    it("rejects an unknown topic before making the create request", async () => {
      await expect(
        publisher.publish(postDraft({ hints: { type: "discussion", topic: "not-a-real-topic" } })),
      ).rejects.toThrow(OpenLabsError);
      // No create call was made (only auth would have been attempted, and we
      // never even queued auth responses, so any unexpected fetch would fail).
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("defaults type and topic when hints are absent", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
        .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ id: "post-2" }, 201));

      await publisher.publish(postDraft({ hints: undefined }));

      const [, init] = fetchMock.mock.calls[2];
      const body = JSON.parse(init.body);
      expect(body.type).toBe("discussion");
      expect(body.topic).toBe("biology-life-sciences");
    });

    it("requires a non-empty title", async () => {
      await expect(publisher.publish(postDraft({ title: "" }))).rejects.toThrow(OpenLabsError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("surfaces retryable: true on a 429", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
        .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({}, 429));

      await expect(publisher.publish(postDraft())).rejects.toMatchObject({ retryable: true });
    });

    it("rethrows an abort/timeout with an operator-facing message", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
        .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }))
        .mockImplementationOnce(() => {
          const err = new Error("aborted");
          err.name = "AbortError";
          return Promise.reject(err);
        });

      await expect(publisher.publish(postDraft())).rejects.toThrow(/check OpenLabs before retrying/i);
    });
  });

  describe("publishing a reply", () => {
    function replyDraft(overrides: Partial<PublishableDraft> = {}): PublishableDraft {
      return {
        kind: "reply",
        id: "draft-2",
        body: "A reply",
        threadExternalId: "post-1",
        parentExternalId: "comment-1",
        ...overrides,
      };
    }

    it("POSTs to /api/v1/posts/{threadExternalId}/comments with the right parent_id", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
        .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ id: "comment-2", post_id: "post-1", parent_id: "comment-1" }, 201));

      const result = await publisher.publish(replyDraft());

      expect(result).toEqual({ externalId: "comment-2", externalUrl: "https://openlabs.bio.xyz/post/post-1" });
      const [url, init] = fetchMock.mock.calls[2];
      expect(url).toBe("https://api.openlabs.bio.xyz/api/v1/posts/post-1/comments");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ body: "A reply", parent_id: "comment-1" });
    });

    it("sends parent_id null for a top-level comment on the post", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
        .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ id: "comment-3", post_id: "post-1", parent_id: null }, 201));

      await publisher.publish(replyDraft({ parentExternalId: null }));

      const [, init] = fetchMock.mock.calls[2];
      expect(JSON.parse(init.body).parent_id).toBeNull();
    });

    it("throws before any fetch when threadExternalId is missing", async () => {
      await expect(publisher.publish(replyDraft({ threadExternalId: null }))).rejects.toThrow(OpenLabsError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not fabricate a #comment-<id> deep link", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
        .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }))
        .mockResolvedValueOnce(jsonResponse({ id: "comment-2" }, 201));

      const result = await publisher.publish(replyDraft());
      expect(result.externalUrl).toBe("https://openlabs.bio.xyz/post/post-1");
    });
  });
});
