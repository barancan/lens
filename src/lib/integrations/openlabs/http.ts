/**
 * Authenticated fetch wrapper for the OpenLabs API. Attaches the bearer
 * token; on a 401 (the token may have been revoked or expired early) it
 * re-mints exactly once and retries — a second 401 fails. No other retries;
 * 429/5xx surface as `OpenLabsError` with `retryable` set for the caller.
 */
import { fetchWithTimeout, userAgent } from "@/lib/integrations/research/http";
import { getAccessToken } from "./auth";
import { openLabsConfig } from "./config";
import { OpenLabsError } from "./errors";

type OpenLabsFetchInit = {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  timeoutMs?: number;
};

function resolveUrl(apiUrl: string, path: string): string {
  const base = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`;
  const relative = path.startsWith("/") ? path.slice(1) : path;
  return new URL(relative, base).toString();
}

async function doFetch(path: string, accessToken: string, init?: OpenLabsFetchInit): Promise<Response> {
  const { apiUrl } = openLabsConfig();
  return fetchWithTimeout(
    resolveUrl(apiUrl, path),
    {
      method: init?.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": userAgent(),
        Authorization: `Bearer ${accessToken}`,
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    },
    init?.timeoutMs,
  );
}

export async function openLabsFetch<T>(path: string, init?: OpenLabsFetchInit): Promise<T> {
  const token = await getAccessToken();
  let res = await doFetch(path, token, init);

  if (res.status === 401) {
    const retryToken = await getAccessToken(true);
    res = await doFetch(path, retryToken, init);
  }

  if (!res.ok) {
    throw new OpenLabsError(`OpenLabs request failed: ${res.status} ${path}`, { status: res.status, endpoint: path });
  }
  return (await res.json()) as T;
}
