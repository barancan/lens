import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOpenLabsAuth, getAccessToken } from "@/lib/integrations/openlabs/auth";
import { OpenLabsCommentSource } from "@/lib/integrations/openlabs/comment-source";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("OpenLabsCommentSource", () => {
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

  it("isEnabled() reflects env only", () => {
    const source = new OpenLabsCommentSource();
    expect(source.isEnabled()).toBe(true);
  });

  it("listComments maps the wire shape into ExternalComment, carrying parent_id into metadata", async () => {
    await warmToken();
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "c1",
          post_id: "post-1",
          parent_id: null,
          body: "top level",
          created_at: "2026-01-01T00:00:00.000Z",
          author: { id: "u1", handle: "alice", display_name: "Alice", account_type: "human" },
        },
        {
          id: "c2",
          post_id: "post-1",
          parent_id: "c1",
          body: "a nested reply",
          created_at: "2026-01-02T00:00:00.000Z",
          author: { id: "u2", handle: "bob", display_name: "Bob", account_type: "human" },
        },
      ]),
    );

    const source = new OpenLabsCommentSource();
    const comments = await source.listComments("post-1");

    expect(comments).toHaveLength(2);
    expect(comments[0]).toEqual({
      externalId: "c1",
      author: "alice",
      body: "top level",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        platform: "openlabs",
        parentExternalId: null,
        authorId: "u1",
        authorDisplayName: "Alice",
        accountType: "human",
      },
    });
    // The `comments` table has no parent column, so `parent_id` must survive
    // in metadata — the reply publisher depends on it.
    expect(comments[1].metadata?.parentExternalId).toBe("c1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openlabs.bio.xyz/api/v1/posts/post-1/comments");
  });

  it("selfHandle calls /profiles/me once and memoizes across repeated calls", async () => {
    await warmToken();
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "u0", handle: "lens" }));

    const source = new OpenLabsCommentSource();
    const [first, second] = await Promise.all([source.selfHandle(), source.selfHandle()]);
    const third = await source.selfHandle();

    expect(first).toBe("lens");
    expect(second).toBe("lens");
    expect(third).toBe("lens");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openlabs.bio.xyz/api/v1/profiles/me");
  });

  it("getReception combines GET /posts/{id} and GET /decisions?post_id=…&status=open", async () => {
    await warmToken();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          id: "post-1",
          upvote_count: 12,
          downvote_count: 2,
          comment_count: 5,
          voting_ends_at: "2026-02-01T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "dec-1", status: "open", voting_ends_at: "2026-02-01T00:00:00.000Z" }] }));

    const source = new OpenLabsCommentSource();
    const reception = await source.getReception("post-1");

    expect(reception.upvotes).toBe(12);
    expect(reception.downvotes).toBe(2);
    expect(reception.commentCount).toBe(5);
    expect(reception.openDecision).toEqual({ id: "dec-1", votingEndsAt: "2026-02-01T00:00:00.000Z" });
    expect(typeof reception.fetchedAt).toBe("string");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toContain("https://api.openlabs.bio.xyz/api/v1/posts/post-1");
    expect(urls.some((u) => u.startsWith("https://api.openlabs.bio.xyz/api/v1/decisions?"))).toBe(true);
    const decisionsUrl = new URL(urls.find((u) => u.includes("/decisions"))!);
    expect(decisionsUrl.searchParams.get("post_id")).toBe("post-1");
    expect(decisionsUrl.searchParams.get("status")).toBe("open");
  });

  it("getReception tolerates a missing decisions array", async () => {
    await warmToken();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "post-1", upvote_count: 0, downvote_count: 0, comment_count: 0 }))
      .mockResolvedValueOnce(jsonResponse({}));

    const source = new OpenLabsCommentSource();
    const reception = await source.getReception("post-1");
    expect(reception.openDecision).toBeNull();
  });
});
