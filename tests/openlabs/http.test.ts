import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, resetOpenLabsAuth } from "@/lib/integrations/openlabs/auth";
import { OpenLabsError } from "@/lib/integrations/openlabs/errors";
import { openLabsFetch } from "@/lib/integrations/openlabs/http";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("openLabsFetch", () => {
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

  /** Warms the token cache so each test's fetch mock only needs to cover the request(s) under test. */
  async function warmToken(accessToken = "access-1") {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: accessToken, expires_in: 3600 }));
    await getAccessToken();
    fetchMock.mockClear();
  }

  it("re-mints exactly once on a 401 and retries successfully", async () => {
    await warmToken("access-1");
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token-2" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-2", expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await openLabsFetch<{ ok: boolean }>("/api/v1/profiles/me");
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const firstAttemptInit = fetchMock.mock.calls[0][1];
    expect(firstAttemptInit.headers.Authorization).toBe("Bearer access-1");
    const retryInit = fetchMock.mock.calls[3][1];
    expect(retryInit.headers.Authorization).toBe("Bearer access-2");
  });

  it("throws an OpenLabsError with status 401 after two consecutive 401s", async () => {
    await warmToken("access-1");
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token-2" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-2", expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    try {
      await openLabsFetch("/api/v1/profiles/me");
      throw new Error("expected openLabsFetch to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenLabsError);
      expect((err as OpenLabsError).status).toBe(401);
    }
    // exactly one re-mint attempt: initial request + remint (2 calls) + retry request = 4
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("marks a 429 response as retryable, with exactly one fetch", async () => {
    await warmToken();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 429));

    try {
      await openLabsFetch("/api/v1/posts");
      throw new Error("expected openLabsFetch to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenLabsError);
      expect((err as OpenLabsError).status).toBe(429);
      expect((err as OpenLabsError).retryable).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks a 500 response as retryable", async () => {
    await warmToken();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));

    try {
      await openLabsFetch("/api/v1/posts");
      throw new Error("expected openLabsFetch to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenLabsError);
      expect((err as OpenLabsError).status).toBe(500);
      expect((err as OpenLabsError).retryable).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
