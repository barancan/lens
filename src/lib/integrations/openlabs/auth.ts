/**
 * Token lifecycle: mint a short-lived agent token from the permanent
 * credential, exchange it for a platform access token, and cache the
 * result. Re-mints when within 60s of expiry (or on `force`, used after a
 * 401) — there is no refresh token.
 * https://openlabs.bio.xyz/auth/agent/SKILL.md
 */
import { fetchWithTimeout, userAgent } from "@/lib/integrations/research/http";
import { openLabsConfig } from "./config";
import { OpenLabsError } from "./errors";

const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3600;

interface AgentTokenResponse {
  data?: { token?: string };
}

interface AuthenticateResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  user_id?: string;
}

let cached: { accessToken: string; expiresAt: number } | null = null;

async function mintAgentToken(idApiUrl: string, agentCredential: string): Promise<string> {
  const endpoint = "/api/v1/auth/agent/token";
  const res = await fetchWithTimeout(`${idApiUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
    body: JSON.stringify({ agentCredential }),
  });
  if (!res.ok) {
    throw new OpenLabsError(`OpenLabs agent token mint failed: ${res.status}`, { status: res.status, endpoint });
  }
  const data = (await res.json()) as AgentTokenResponse;
  const token = data.data?.token;
  if (!token) {
    throw new OpenLabsError("OpenLabs agent token response missing token", { endpoint });
  }
  return token;
}

async function authenticate(apiUrl: string, agentToken: string): Promise<{ accessToken: string; expiresInS: number }> {
  const endpoint = "/api/v1/auth/authenticate";
  const res = await fetchWithTimeout(`${apiUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": userAgent(),
      Authorization: `Bearer ${agentToken}`,
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new OpenLabsError(`OpenLabs authenticate failed: ${res.status}`, { status: res.status, endpoint });
  }
  const data = (await res.json()) as AuthenticateResponse;
  if (!data.access_token) {
    throw new OpenLabsError("OpenLabs authenticate response missing access_token", { endpoint });
  }
  return { accessToken: data.access_token, expiresInS: data.expires_in ?? DEFAULT_EXPIRES_IN_S };
}

/** Returns a valid access token, minting/re-minting as needed. `force` skips the cache (used after a 401). */
export async function getAccessToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt - EXPIRY_SKEW_MS > now) {
    return cached.accessToken;
  }

  const { idApiUrl, apiUrl, agentCredential } = openLabsConfig();
  const agentToken = await mintAgentToken(idApiUrl, agentCredential);
  const { accessToken, expiresInS } = await authenticate(apiUrl, agentToken);
  cached = { accessToken, expiresAt: now + expiresInS * 1000 };
  return cached.accessToken;
}

/** Test seam: clears the module-level token cache so it never leaks between tests. */
export function resetOpenLabsAuth(): void {
  cached = null;
}
