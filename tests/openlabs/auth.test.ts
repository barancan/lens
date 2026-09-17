import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, resetOpenLabsAuth } from "@/lib/integrations/openlabs/auth";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const MINT_URL = "https://api.id.bio.xyz/api/v1/auth/agent/token";
const AUTH_URL = "https://api.openlabs.bio.xyz/api/v1/auth/authenticate";

describe("getAccessToken", () => {
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

  it("mints a token via the two-leg flow", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "access-1", expires_in: 3600, token_type: "Bearer", user_id: "u1" }),
      );

    const token = await getAccessToken();
    expect(token).toBe("access-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(fetchMock.mock.calls[0][0]).toBe(MINT_URL);
    const mintInit = fetchMock.mock.calls[0][1];
    expect(mintInit.method).toBe("POST");
    expect(JSON.parse(mintInit.body)).toEqual({ agentCredential: "cred-123" });

    expect(fetchMock.mock.calls[1][0]).toBe(AUTH_URL);
    const authInit = fetchMock.mock.calls[1][1];
    expect(authInit.method).toBe("POST");
    expect(authInit.headers.Authorization).toBe("Bearer agent-token");
    expect(JSON.parse(authInit.body)).toEqual({});
  });

  it("reuses the cached token within the TTL, making zero fetches", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 3600 }));
    await getAccessToken();
    fetchMock.mockClear();

    const token = await getAccessToken();
    expect(token).toBe("access-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-mints when the cached token is within the 60s expiry skew", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-1", expires_in: 30 })); // < 60s skew
    await getAccessToken();
    fetchMock.mockClear();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token-2" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-2", expires_in: 3600 }));
    const token = await getAccessToken();
    expect(token).toBe("access-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("assumes a 3600s expiry when expires_in is missing from the response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { token: "agent-token" } }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "access-1" }));
    const token = await getAccessToken();
    expect(token).toBe("access-1");
    fetchMock.mockClear();

    const cachedToken = await getAccessToken();
    expect(cachedToken).toBe("access-1");
    expect(fetchMock).not.toHaveBeenCalled(); // still within the assumed 3600s TTL
  });
});
