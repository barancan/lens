import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingProvider, OpenAIProvider } from "@/lib/providers/openai/adapter";
import { LLMError, type LLMRequest } from "@/lib/llm/types";

/** Minimal fake of the OpenAI SDK surface the adapter uses. */
function fakeChatClient(create: (params: unknown) => unknown) {
  return { chat: { completions: { create: vi.fn(create) } } };
}

function baseRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "gpt-6",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function fakeCompletion(overrides: Partial<OpenAI.ChatCompletion> = {}): OpenAI.ChatCompletion {
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 0,
    model: "gpt-6",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: "hello", refusal: null },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  } as OpenAI.ChatCompletion;
}

describe("OpenAIProvider request mapping", () => {
  it("maps system to a system message", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeChatClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeCompletion();
    });
    const provider = new OpenAIProvider(client as never);

    await provider.generate(baseRequest({ system: "be helpful" }));

    expect(captured.messages).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("maps tool results to one role:tool message per result", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeChatClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeCompletion();
    });
    const provider = new OpenAIProvider(client as never);

    await provider.generate(
      baseRequest({
        messages: [
          {
            role: "tool",
            content: [
              { type: "tool_result", toolCallId: "call_1", content: "42" },
              { type: "tool_result", toolCallId: "call_2", content: "43" },
            ],
          },
        ],
      }),
    );

    expect(captured.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "42" },
      { role: "tool", tool_call_id: "call_2", content: "43" },
    ]);
  });

  it("maps assistant tool calls to tool_calls with JSON-string arguments", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeChatClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeCompletion();
    });
    const provider = new OpenAIProvider(client as never);

    await provider.generate(
      baseRequest({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_call", id: "call_1", name: "lookup", input: { q: "x" } }],
          },
        ],
      }),
    );

    expect(captured.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ q: "x" }) } }],
      },
    ]);
  });

  it("maps tools and toolChoice", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeChatClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeCompletion();
    });
    const provider = new OpenAIProvider(client as never);
    const tools = [{ name: "lookup", description: "look things up", inputSchema: { type: "object" as const } }];

    await provider.generate(baseRequest({ tools, toolChoice: "required" }));
    expect(captured.tools).toEqual([
      { type: "function", function: { name: "lookup", description: "look things up", parameters: { type: "object" } } },
    ]);
    expect(captured.tool_choice).toBe("required");

    await provider.generate(baseRequest({ tools, toolChoice: { name: "lookup" } }));
    expect(captured.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
  });

  it("maps responseSchema to response_format json_schema", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeChatClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeCompletion({
        choices: [
          { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", content: '{"value":42}', refusal: null } },
        ],
      });
    });
    const provider = new OpenAIProvider(client as never);

    const response = await provider.generate(
      baseRequest({ responseSchema: { name: "answer", schema: { type: "object", properties: { value: { type: "number" } } } } }),
    );

    expect(captured.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "answer",
        description: undefined,
        schema: { type: "object", properties: { value: { type: "number" } } },
        strict: false,
      },
    });
    expect(response.text).toBe('{"value":42}');
    expect(response.toolCalls).toEqual([]);
  });

  it("uses max_completion_tokens, defaulting to 4096, and omits temperature when undefined", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeChatClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeCompletion();
    });
    const provider = new OpenAIProvider(client as never);

    await provider.generate(baseRequest());
    expect(captured.max_completion_tokens).toBe(4096);
    expect("temperature" in captured).toBe(false);

    await provider.generate(baseRequest({ maxTokens: 200, temperature: 0.2 }));
    expect(captured.max_completion_tokens).toBe(200);
    expect(captured.temperature).toBe(0.2);
  });
});

describe("OpenAIProvider response mapping", () => {
  it("maps text, usage and finish_reason stop", async () => {
    const client = fakeChatClient(() => fakeCompletion());
    const provider = new OpenAIProvider(client as never);
    const response = await provider.generate(baseRequest());

    expect(response.text).toBe("hello");
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(response.stopReason).toBe("end");
    expect(response.provider).toBe("openai");
  });

  it("parses tool call arguments and maps finish_reason tool_calls", async () => {
    const client = fakeChatClient(() =>
      fakeCompletion({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            logprobs: null,
            message: {
              role: "assistant",
              content: null,
              refusal: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
            },
          },
        ],
      }),
    );
    const provider = new OpenAIProvider(client as never);
    const response = await provider.generate(baseRequest());

    expect(response.toolCalls).toEqual([{ type: "tool_call", id: "call_1", name: "lookup", input: { q: "x" } }]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("keeps the raw string under _raw when tool call arguments fail to parse", async () => {
    const client = fakeChatClient(() =>
      fakeCompletion({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            logprobs: null,
            message: {
              role: "assistant",
              content: null,
              refusal: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "not json" } }],
            },
          },
        ],
      }),
    );
    const provider = new OpenAIProvider(client as never);
    const response = await provider.generate(baseRequest());

    expect(response.toolCalls[0]?.input).toEqual({ _raw: "not json" });
  });

  it("maps finish_reason length to max_tokens", async () => {
    const client = fakeChatClient(() => fakeCompletion({ choices: [{ index: 0, finish_reason: "length", logprobs: null, message: { role: "assistant", content: "cut off", refusal: null } }] }));
    const provider = new OpenAIProvider(client as never);
    const response = await provider.generate(baseRequest());
    expect(response.stopReason).toBe("max_tokens");
  });
});

describe("OpenAIProvider error mapping", () => {
  it("wraps a 429 as retryable and a 400 as non-retryable", async () => {
    const rateLimited = new OpenAI.APIError(429, { message: "slow down" }, "slow down", new Headers());
    let client = fakeChatClient(() => {
      throw rateLimited;
    });
    let provider = new OpenAIProvider(client as never);
    await expect(provider.generate(baseRequest())).rejects.toBeInstanceOf(LLMError);
    await expect(provider.generate(baseRequest())).rejects.toMatchObject({ provider: "openai", retryable: true });

    const badRequest = new OpenAI.APIError(400, { message: "bad" }, "bad", new Headers());
    client = fakeChatClient(() => {
      throw badRequest;
    });
    provider = new OpenAIProvider(client as never);
    await expect(provider.generate(baseRequest())).rejects.toMatchObject({ retryable: false });
  });

  it("wraps a 500 as retryable", async () => {
    const serverError = new OpenAI.APIError(500, { message: "oops" }, "oops", new Headers());
    const client = fakeChatClient(() => {
      throw serverError;
    });
    const provider = new OpenAIProvider(client as never);
    await expect(provider.generate(baseRequest())).rejects.toMatchObject({ retryable: true });
  });
});

describe("OpenAIEmbeddingProvider", () => {
  it("has 1536 dimensions", () => {
    const provider = new OpenAIEmbeddingProvider("text-embedding-3-small", { embeddings: { create: vi.fn() } } as never);
    expect(provider.dimensions).toBe(1536);
  });

  it("batches inputs in groups of <=100 and preserves order", async () => {
    const inputs = Array.from({ length: 250 }, (_, i) => `text-${i}`);
    const batchSizes: number[] = [];
    const create = vi.fn(async (params: { input: string[] }) => {
      batchSizes.push(params.input.length);
      return {
        data: params.input.map((text, index) => ({ object: "embedding" as const, index, embedding: [Number(text.split("-")[1])] })),
        model: "text-embedding-3-small",
        object: "list" as const,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      };
    });
    const provider = new OpenAIEmbeddingProvider("text-embedding-3-small", { embeddings: { create } } as never);

    const result = await provider.embed(inputs);

    expect(batchSizes).toEqual([100, 100, 50]);
    expect(result).toHaveLength(250);
    expect(result[0]).toEqual([0]);
    expect(result[249]).toEqual([249]);
  });

  it("replaces empty strings with a single space", async () => {
    let captured: string[] = [];
    const create = vi.fn(async (params: { input: string[] }) => {
      captured = params.input;
      return {
        data: params.input.map((_, index) => ({ object: "embedding" as const, index, embedding: [index] })),
        model: "text-embedding-3-small",
        object: "list" as const,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      };
    });
    const provider = new OpenAIEmbeddingProvider("text-embedding-3-small", { embeddings: { create } } as never);

    await provider.embed(["hello", "", "world"]);

    expect(captured).toEqual(["hello", " ", "world"]);
  });
});
