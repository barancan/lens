import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, resetOpenLabsAuth } from "@/lib/integrations/openlabs/auth";
import { broadestTerm, OpenLabsDiscoverySource } from "@/lib/integrations/openlabs/discovery";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    type: "discussion",
    title: "Cyclic OSK and teratoma risk",
    body: "A community post body.",
    author: { handle: "methyl_maven" },
    topic: { slug: "biology-life-sciences" },
    tags: ["osk"],
    created_at: "2026-09-10T00:00:00.000Z",
    comment_count: 3,
    upvote_count: 12,
    ...overrides,
  };
}

describe("broadestTerm", () => {
  it("returns the longest term of a multi-word query", () => {
    expect(broadestTerm("partial reprogramming teratoma")).toBe("reprogramming");
    expect(broadestTerm("OSK safety tumorigenesis")).toBe("tumorigenesis");
  });

  it("returns null when there is nothing to broaden to", () => {
    expect(broadestTerm("reprogramming")).toBeNull();
    expect(broadestTerm("")).toBeNull();
    // Short filler words are not terms worth searching on their own.
    expect(broadestTerm("of in a")).toBeNull();
  });

  it("ignores punctuation when measuring terms", () => {
    expect(broadestTerm("teratoma, reprogramming!")).toBe("reprogramming");
  });
});

describe("OpenLabsDiscoverySource", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENLABS_AGENT_CREDENTIAL", "cred-123");
    resetOpenLabsAuth();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }));
    await getAccessToken();
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetOpenLabsAuth();
  });

  const urlOf = (call: number) => String(fetchMock.mock.calls[call][0]);

  it("maps posts into neutral discovered items", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [post()], total: 1 }));

    const items = await new OpenLabsDiscoverySource().search({ query: "teratoma", kinds: ["post"] });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceId: "openlabs",
      kind: "post",
      externalId: "post-1",
      title: "Cyclic OSK and teratoma risk",
      author: "methyl_maven",
      topic: "biology-life-sciences",
      metrics: { comments: 3, upvotes: 12 },
    });
    expect(items[0].url).toContain("/post/post-1");
  });

  it("skips items missing an id or title rather than emitting junk", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [post(), { id: "no-title" }, { title: "no id" }], total: 3 }),
    );
    const items = await new OpenLabsDiscoverySource().search({ query: "teratoma", kinds: ["post"] });
    expect(items.map((i) => i.externalId)).toEqual(["post-1"]);
  });

  it("broadens a multi-term query that returns nothing", async () => {
    // OpenLabs appears to AND search terms, so a long phrase can match nothing
    // even when each term matches plenty.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [], total: 0 }))
      .mockResolvedValueOnce(jsonResponse({ data: [post()], total: 1 }));

    const items = await new OpenLabsDiscoverySource().search({
      query: "partial reprogramming teratoma",
      kinds: ["post"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(0)).toContain("search=partial+reprogramming+teratoma");
    expect(urlOf(1)).toContain("search=reprogramming");
    expect(items).toHaveLength(1);
  });

  it("does not broaden when the first attempt already found something", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [post()], total: 1 }));
    await new OpenLabsDiscoverySource().search({ query: "partial reprogramming teratoma", kinds: ["post"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not broaden a single-term query that found nothing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [], total: 0 }));
    const items = await new OpenLabsDiscoverySource().search({ query: "teratoma", kinds: ["post"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(items).toEqual([]);
  });

  it("passes the topic filter through and omits empty params", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [post()], total: 1 }));
    await new OpenLabsDiscoverySource().search({ query: "osk", topic: "biology-life-sciences", kinds: ["post"] });

    const url = urlOf(0);
    expect(url).toContain("topic=biology-life-sciences");
    expect(url).toContain("sort=trending");
    expect(url).not.toContain("type=");
  });

  it("searches posts and projects together by default", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [post()], total: 1 }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "proj-1", title: "A project", summary: "About aging.", thread_count: 2 }], total: 1 }),
      );

    const items = await new OpenLabsDiscoverySource().search({ query: "aging" });

    expect(urlOf(0)).toContain("/api/v1/posts");
    expect(urlOf(1)).toContain("/api/v1/projects");
    expect(items.map((i) => i.kind)).toEqual(["post", "project"]);
    expect(items[1]).toMatchObject({ kind: "project", externalId: "proj-1", metrics: { threads: 2 } });
  });

  it("is disabled without a credential", () => {
    vi.unstubAllEnvs();
    expect(new OpenLabsDiscoverySource().isEnabled()).toBe(false);
  });
});
