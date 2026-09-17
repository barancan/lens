import { MockResearchSource, type MockResearchEntry } from "@/lib/integrations/research/registry";
import { createKnowledgeService } from "@/lib/knowledge/service";
import type { LLMProvider, LLMRequest, LLMResponse, ToolCallPart } from "@/lib/llm/types";
import type { AgentDeps } from "@/lib/workflows/types";
import { fakeEmbedding } from "./db";

type Handler = (req: LLMRequest, prompt: string) => unknown | Promise<unknown>;

/**
 * Deterministic LLM for workflow tests. Structured requests are answered by the
 * handler registered for `responseSchema.name`; free-form/tool requests by
 * the `chat` handler, which may return `{ text }` or `{ toolCalls }`.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly requests: LLMRequest[] = [];

  constructor(
    private readonly handlers: Record<string, Handler>,
    private readonly chat?: (req: LLMRequest, call: number) => { text?: string; toolCalls?: ToolCallPart[] },
  ) {}

  calls(name: string): LLMRequest[] {
    return this.requests.filter((r) => r.responseSchema?.name === name);
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const prompt = req.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    const base = { usage: { inputTokens: 10, outputTokens: 5 }, model: req.model, provider: this.name };
    if (req.responseSchema) {
      const handler = this.handlers[req.responseSchema.name];
      if (!handler) throw new Error(`No scripted response for ${req.responseSchema.name}`);
      const out = await handler(req, prompt);
      return { ...base, text: JSON.stringify(out), toolCalls: [], stopReason: "end" };
    }
    if (!this.chat) throw new Error("No chat handler scripted");
    const out = this.chat(req, this.requests.filter((r) => !r.responseSchema).length);
    return {
      ...base,
      text: out.text ?? "",
      toolCalls: out.toolCalls ?? [],
      stopReason: out.toolCalls?.length ? "tool_use" : "end",
    };
  }
}

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export function idsIn(text: string): string[] {
  return [...new Set(text.match(UUID_RE) ?? [])];
}

export const OSK_PAPER_TEXT = `Cyclic induction of OSK in aged mice was performed for 12 weeks.
Treated mice showed improved glucose tolerance compared with controls.
No teratomas were detected in any treated animal during the observation period.
Continuous OSKM expression, by contrast, led to teratoma formation within weeks.`;

export function oskEntry(overrides: Partial<MockResearchEntry["result"]> = {}): MockResearchEntry {
  return {
    result: {
      sourceId: "mock",
      externalId: "mock:1",
      title: "Cyclic OSK expression and teratoma risk in aged mice",
      url: "https://example.org/osk",
      doi: "10.1000/osk.1",
      authors: ["Ada Smith", "Ben Jones"],
      publicationDate: "2024-03-01",
      sourceType: "paper",
      snippet: "teratoma safety of cyclic OSK",
      metadata: {},
      ...overrides,
    },
    document: {
      title: "Cyclic OSK expression and teratoma risk in aged mice",
      url: "https://example.org/osk",
      doi: "10.1000/osk.1",
      authors: ["Ada Smith", "Ben Jones"],
      publicationDate: "2024-03-01",
      sourceType: "paper",
      text: OSK_PAPER_TEXT,
      textKind: "abstract",
      metadata: {},
    },
  };
}

export function makeDeps(provider: LLMProvider, entries: MockResearchEntry[] = [oskEntry()]) {
  const launched: string[] = [];
  const mock = new MockResearchSource(entries);
  const deps: AgentDeps = {
    knowledge: createKnowledgeService({ embed: async (texts) => texts.map((t) => fakeEmbedding(t)) }),
    getProvider: () => provider,
    getResearchSources: () => [mock],
    fetchUrl: async (url) => ({
      title: `Page ${url}`,
      url,
      doi: null,
      authors: [],
      publicationDate: null,
      sourceType: "web_page",
      text: OSK_PAPER_TEXT,
      textKind: "page",
      metadata: {},
    }),
    launchTask: (id) => void launched.push(id),
  };
  return { deps, launched };
}
