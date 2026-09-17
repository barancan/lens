import { beforeEach, describe, expect, it } from "vitest";
import { getEmbeddingProvider, getProvider, registerProvider, resetProviders } from "@/lib/llm/registry";
import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "@/lib/llm/types";

// getEmbeddingProvider constructs a real OpenAIEmbeddingProvider (with a lazily
// created client); give it a fake key so construction doesn't throw. No network
// calls are made in these tests.
process.env.OPENAI_API_KEY ??= "test-key";

beforeEach(() => {
  resetProviders();
});

function fakeProvider(name: LLMProvider["name"]): LLMProvider {
  return {
    name,
    generate: async (): Promise<LLMResponse> => ({
      text: "ok",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "fake",
      provider: name,
    }),
  };
}

describe("getProvider", () => {
  it("caches singletons across calls", () => {
    // These stub providers throw on generate() but are safe to construct without API keys.
    const first = getProvider("bios");
    const second = getProvider("bios");
    expect(first).toBe(second);
  });

  it("returns the registered override instead of constructing a new one", () => {
    const override = fakeProvider("anthropic");
    registerProvider("anthropic", override);
    expect(getProvider("anthropic")).toBe(override);
  });

  it("resetProviders clears cached instances", () => {
    const override = fakeProvider("bios");
    registerProvider("bios", override);
    expect(getProvider("bios")).toBe(override);

    resetProviders();
    expect(getProvider("bios")).not.toBe(override);
  });
});

describe("stub providers", () => {
  it("bios provider throws LLMError on generate", async () => {
    const provider = getProvider("bios");
    const request: LLMRequest = { model: "x", messages: [{ role: "user", content: "hi" }] };
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMError);
  });

  it("local provider throws LLMError on generate", async () => {
    const provider = getProvider("local");
    const request: LLMRequest = { model: "x", messages: [{ role: "user", content: "hi" }] };
    await expect(provider.generate(request)).rejects.toBeInstanceOf(LLMError);
  });
});

describe("getEmbeddingProvider", () => {
  it("throws for a provider other than openai", () => {
    expect(() => getEmbeddingProvider({ provider: "anthropic", model: "whatever" })).toThrow(LLMError);
  });

  it("caches by provider+model", () => {
    const first = getEmbeddingProvider({ provider: "openai", model: "text-embedding-3-small" });
    const second = getEmbeddingProvider({ provider: "openai", model: "text-embedding-3-small" });
    const differentModel = getEmbeddingProvider({ provider: "openai", model: "text-embedding-3-large" });

    expect(first).toBe(second);
    expect(first).not.toBe(differentModel);
    expect(first.dimensions).toBe(1536);
  });
});
