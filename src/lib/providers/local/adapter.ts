import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "@/lib/llm/types";

/**
 * Local provider stub, for a self-hosted OpenAI-compatible endpoint (e.g.
 * Ollama, vLLM, LM Studio).
 *
 * To implement: most local inference servers speak the OpenAI Chat
 * Completions API, so this can likely reuse `OpenAIProvider` wholesale rather
 * than duplicating request/response mapping:
 *
 *   import OpenAI from "openai";
 *   import { OpenAIProvider } from "@/lib/providers/openai/adapter";
 *
 *   const client = new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "local" });
 *   export function getLocalProvider() {
 *     return new OpenAIProvider(client);
 *   }
 *
 * Only build a dedicated adapter here if the local server's API diverges
 * from OpenAI's in ways the shared adapter can't absorb.
 */
export class LocalProvider implements LLMProvider {
  readonly name = "local" as const;

  async generate(_request: LLMRequest): Promise<LLMResponse> {
    throw new LLMError("local provider is not implemented yet", "local", false);
  }
}
