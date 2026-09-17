import "server-only";

import OpenAI from "openai";
import { readEnv } from "@/lib/env";
import { LLMError } from "@/lib/llm/types";

let client: OpenAI | undefined;

/**
 * Lazy singleton OpenAI SDK client. Created on first use so that modules can
 * be imported without OPENAI_API_KEY being present (e.g. in tests that inject
 * their own fake client into the adapter).
 */
export function getOpenAIClient(): OpenAI {
  if (client) return client;

  const apiKey = readEnv("OPENAI_API_KEY");
  if (!apiKey) {
    throw new LLMError("OPENAI_API_KEY is not configured", "openai", false);
  }

  client = new OpenAI({ apiKey });
  return client;
}
