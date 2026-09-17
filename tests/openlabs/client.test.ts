import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, resetOpenLabsAuth } from "@/lib/integrations/openlabs/auth";
import {
  createOpenLabsComment,
  createOpenLabsPost,
  getOpenLabsProfile,
  listOpenLabsComments,
  updateOpenLabsProfile,
} from "@/lib/integrations/openlabs/client";
import { OpenLabsError } from "@/lib/integrations/openlabs/errors";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("OpenLabs client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENLABS_AGENT_CREDENTIAL", "cred-123");
    resetOpenLabsAuth();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetOpenLabsAuth();
  });

  /** Warms the token cache so each test's fetch mock only needs to cover the endpoint call under test. */
  async function warmToken() {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }));
    await getAccessToken();
    fetchMock.mockClear();
  }

  it("createOpenLabsPost POSTs /api/v1/posts with the given body", async () => {
    await warmToken();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "post-1", type: "discussion" }, 201));

    const post = await createOpenLabsPost({
      type: "discussion",
      title: "A title",
      body: "Some body",
      topic: "biology-life-sciences",
      tags: ["aging"],
    });

    expect(post).toEqual({ id: "post-1", type: "discussion" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openlabs.bio.xyz/api/v1/posts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      type: "discussion",
      title: "A title",
      body: "Some body",
      topic: "biology-life-sciences",
      tags: ["aging"],
    });
  });

  it("rejects an over-length title locally, making zero fetches", async () => {
    await expect(
      createOpenLabsPost({ type: "discussion", title: "x".repeat(501), body: "b", topic: "biology-life-sciences" }),
    ).rejects.toThrow(OpenLabsError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty post body locally, making zero fetches", async () => {
    await expect(
      createOpenLabsPost({ type: "discussion", title: "t", body: "", topic: "biology-life-sciences" }),
    ).rejects.toThrow(OpenLabsError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createOpenLabsComment POSTs /api/v1/posts/{postId}/comments with the given body", async () => {
    await warmToken();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "c1", post_id: "post-1", parent_id: null }, 201));

    const comment = await createOpenLabsComment("post-1", { body: "hi", parent_id: null });
    expect(comment.id).toBe("c1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openlabs.bio.xyz/api/v1/posts/post-1/comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ body: "hi", parent_id: null });
  });

  it("rejects an empty comment body locally, making zero fetches", async () => {
    await expect(createOpenLabsComment("post-1", { body: "", parent_id: null })).rejects.toThrow(OpenLabsError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("listOpenLabsComments GETs /api/v1/posts/{postId}/comments", async () => {
    await warmToken();
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: "c1" }, { id: "c2" }]));

    const comments = await listOpenLabsComments("post-1");
    expect(comments).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openlabs.bio.xyz/api/v1/posts/post-1/comments");
    expect(init.method).toBe("GET");
  });

  it("getOpenLabsProfile GETs /api/v1/profiles/me", async () => {
    await warmToken();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "u1", handle: "lens" }));

    const profile = await getOpenLabsProfile();
    expect(profile.handle).toBe("lens");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openlabs.bio.xyz/api/v1/profiles/me");
    expect(init.method).toBe("GET");
  });

  it("updateOpenLabsProfile PUTs /api/v1/profiles/me with the patch", async () => {
    await warmToken();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "u1", handle: "lens", display_name: "LENS" }));

    const profile = await updateOpenLabsProfile({ display_name: "LENS" });
    expect(profile.display_name).toBe("LENS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openlabs.bio.xyz/api/v1/profiles/me");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ display_name: "LENS" });
  });
});
