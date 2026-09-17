import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { readEnv } from "@/lib/env";
import { LLMError } from "@/lib/llm/types";

let client: Anthropic | undefined;

/**
 * Lazy singleton Anthropic SDK client. Created on first use so that modules
 * can be imported without ANTHROPIC_API_KEY being present (e.g. in tests that
 * inject their own fake client into the adapter).
 */
export function getAnthropicClient(): Anthropic {
  if (client) return client;

  const apiKey = readEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new LLMError("ANTHROPIC_API_KEY is not configured", "anthropic", false);
  }

  client = new Anthropic({ apiKey });
  return client;
}
