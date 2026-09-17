import type { z } from "zod";
import { generateStructured } from "@/lib/llm/structured";
import type { LLMProvider, LLMRequest, LLMResponse, ModelRef, ProviderName } from "@/lib/llm/types";
import { appendLlmCall } from "@/lib/repo/runs";
import type { Settings, WorkflowModelKey } from "@/lib/settings/schema";

type Request = Omit<LLMRequest, "model">;

/**
 * Per-run access to LLMs by *workflow key* (e.g. "research_planner").
 * Resolves provider/model from settings and logs every call to the run.
 */
export interface LlmGateway {
  modelFor(key: WorkflowModelKey): ModelRef;
  generate(key: WorkflowModelKey, purpose: string, request: Request): Promise<LLMResponse>;
  structured<T>(
    key: WorkflowModelKey,
    purpose: string,
    request: Omit<Request, "responseSchema" | "tools" | "toolChoice">,
    output: { name: string; description?: string; schema: z.ZodType<T> },
  ): Promise<{ data: T; response: LLMResponse }>;
}

export function createLlmGateway(
  runId: string,
  models: Settings["models"],
  getProvider: (name: ProviderName) => LLMProvider,
): LlmGateway {
  const modelFor = (key: WorkflowModelKey): ModelRef => models[key];

  async function logged<T>(
    ref: ModelRef,
    purpose: string,
    fn: () => Promise<T>,
    usageOf: (out: T) => { inputTokens: number; outputTokens: number },
  ): Promise<T> {
    const started = Date.now();
    try {
      const out = await fn();
      const usage = usageOf(out);
      await appendLlmCall(runId, {
        purpose,
        provider: ref.provider,
        model: ref.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - started,
        at: new Date(started).toISOString(),
      });
      return out;
    } catch (err) {
      await appendLlmCall(runId, {
        purpose,
        provider: ref.provider,
        model: ref.model,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - started,
        at: new Date(started).toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  return {
    modelFor,
    async generate(key, purpose, request) {
      const ref = modelFor(key);
      return logged(
        ref,
        purpose,
        () => getProvider(ref.provider).generate({ ...request, model: ref.model }),
        (r) => r.usage,
      );
    },
    async structured(key, purpose, request, output) {
      const ref = modelFor(key);
      const provider = getProvider(ref.provider);
      const result = await logged(
        ref,
        purpose,
        () => generateStructured(provider, { ...request, model: ref.model }, output),
        (r) => r.response.usage,
      );
      return { data: result.data, response: result.response };
    },
  };
}
