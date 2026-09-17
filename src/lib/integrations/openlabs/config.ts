/**
 * OpenLabs configuration: base URLs and the permanent agent credential that
 * mints session tokens. https://openlabs.bio.xyz
 */
import { readEnv, requireEnv } from "@/lib/env";

export interface OpenLabsConfig {
  idApiUrl: string;
  apiUrl: string;
  publicBaseUrl: string;
  agentCredential: string;
}

const DEFAULT_API_URL = "https://api.openlabs.bio.xyz";
const DEFAULT_ID_API_URL = "https://api.id.bio.xyz";
const DEFAULT_PUBLIC_URL = "https://openlabs.bio.xyz";

/** Enablement is env-only (never throws), since `isEnabled()` on the adapters is synchronous. */
export function isOpenLabsConfigured(): boolean {
  return Boolean(readEnv("OPENLABS_AGENT_CREDENTIAL"));
}

/** Resolved config; throws (via `requireEnv`) when the agent credential is missing. */
export function openLabsConfig(): OpenLabsConfig {
  return {
    idApiUrl: readEnv("OPENLABS_ID_API_URL") || DEFAULT_ID_API_URL,
    apiUrl: readEnv("OPENLABS_API_URL") || DEFAULT_API_URL,
    publicBaseUrl: readEnv("OPENLABS_PUBLIC_URL") || DEFAULT_PUBLIC_URL,
    agentCredential: requireEnv("OPENLABS_AGENT_CREDENTIAL"),
  };
}

/** Public URL for a post, e.g. `https://openlabs.bio.xyz/post/{id}`. There is no URL in the API response. */
export function openLabsPostUrl(postId: string): string {
  const { publicBaseUrl } = openLabsConfig();
  return `${publicBaseUrl}/post/${postId}`;
}
