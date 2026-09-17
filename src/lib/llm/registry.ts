import { LLMError, type EmbeddingProvider, type LLMProvider, type ModelRef, type ProviderName } from "@/lib/llm/types";
import { AnthropicProvider } from "@/lib/providers/anthropic/adapter";
import { BiosProvider } from "@/lib/providers/bios/adapter";
import { LocalProvider } from "@/lib/providers/local/adapter";
import { OpenAIEmbeddingProvider, OpenAIProvider } from "@/lib/providers/openai/adapter";

const providers = new Map<ProviderName, LLMProvider>();
const embeddingProviders = new Map<string, EmbeddingProvider>();

function createProvider(name: ProviderName): LLMProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "bios":
      return new BiosProvider();
    case "local":
      return new LocalProvider();
  }
}

/** Returns the singleton LLMProvider for `name`, constructing it on first use. */
export function getProvider(name: ProviderName): LLMProvider {
  const existing = providers.get(name);
  if (existing) return existing;
  const created = createProvider(name);
  providers.set(name, created);
  return created;
}

/** Returns the singleton EmbeddingProvider for a model ref. Only OpenAI is supported today. */
export function getEmbeddingProvider(ref: ModelRef): EmbeddingProvider {
  if (ref.provider !== "openai") {
    throw new LLMError(`No embedding provider available for "${ref.provider}"`, ref.provider, false);
  }

  const key = `${ref.provider}:${ref.model}`;
  const existing = embeddingProviders.get(key);
  if (existing) return existing;
  const created = new OpenAIEmbeddingProvider(ref.model);
  embeddingProviders.set(key, created);
  return created;
}

/** Test/override hook: install a specific provider instance, bypassing lazy construction. */
export function registerProvider(name: ProviderName, provider: LLMProvider): void {
  providers.set(name, provider);
}

/** Test hook: clear all cached LLM and embedding providers. */
export function resetProviders(): void {
  providers.clear();
  embeddingProviders.clear();
}
