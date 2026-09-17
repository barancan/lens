import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "@/lib/llm/types";

/**
 * BIOS provider stub.
 *
 * To implement: BIOS models are reachable either through BIOS's own HTTP API
 * or through an MCP server it exposes. Once the transport is settled:
 *  1. Add a `client.ts` alongside this file with a lazy singleton for that
 *     transport (mirroring `providers/anthropic/client.ts`).
 *  2. In this adapter, map `LLMRequest` (messages/system/tools/toolChoice/
 *     responseSchema) into BIOS's request shape, the same way the Anthropic
 *     and OpenAI adapters do, and map its response back into `LLMResponse`
 *     (text, toolCalls, stopReason, usage).
 *  3. Wrap transport errors in `LLMError`, marking retryable ones (rate
 *     limits, 5xx) accordingly.
 */
export class BiosProvider implements LLMProvider {
  readonly name = "bios" as const;

  async generate(_request: LLMRequest): Promise<LLMResponse> {
    throw new LLMError("bios provider is not implemented yet", "bios", false);
  }
}
