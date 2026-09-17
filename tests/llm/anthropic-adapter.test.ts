import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "@/lib/providers/anthropic/adapter";
import { LLMError, type LLMRequest } from "@/lib/llm/types";

/** Minimal fake of the Anthropic SDK surface the adapter uses. */
function fakeClient(create: (params: unknown) => unknown) {
  return { messages: { create: vi.fn(create) } };
}

function baseRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function fakeMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "hello", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    server_tool_use: null,
    output_tokens_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
    } as Anthropic.Usage,
    ...overrides,
  } as Anthropic.Message;
}

describe("AnthropicProvider request mapping", () => {
  it("puts system at the top level and passes user messages through", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeMessage();
    });
    const provider = new AnthropicProvider(client as never);

    await provider.generate(baseRequest({ system: "be helpful" }));

    expect(captured.system).toBe("be helpful");
    expect(captured.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("maps tool role messages to a user message with tool_result blocks", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeMessage();
    });
    const provider = new AnthropicProvider(client as never);

    await provider.generate(
      baseRequest({
        messages: [
          { role: "tool", content: [{ type: "tool_result", toolCallId: "call_1", content: "42", isError: false }] },
        ],
      }),
    );

    expect(captured.messages).toEqual([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "42", is_error: false }],
      },
    ]);
  });

  it("maps assistant tool_call parts to tool_use blocks", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeMessage();
    });
    const provider = new AnthropicProvider(client as never);

    await provider.generate(
      baseRequest({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "let me check" },
              { type: "tool_call", id: "call_1", name: "lookup", input: { q: "x" } },
            ],
          },
        ],
      }),
    );

    expect(captured.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
        ],
      },
    ]);
  });

  it("maps tools and each toolChoice variant", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeMessage();
    });
    const provider = new AnthropicProvider(client as never);
    const tools = [{ name: "lookup", description: "look things up", inputSchema: { type: "object" as const } }];

    await provider.generate(baseRequest({ tools, toolChoice: "auto" }));
    expect(captured.tools).toEqual([{ name: "lookup", description: "look things up", input_schema: { type: "object" } }]);
    expect(captured.tool_choice).toEqual({ type: "auto" });

    await provider.generate(baseRequest({ tools, toolChoice: "none" }));
    expect(captured.tool_choice).toEqual({ type: "none" });

    await provider.generate(baseRequest({ tools, toolChoice: "required" }));
    expect(captured.tool_choice).toEqual({ type: "any" });

    await provider.generate(baseRequest({ tools, toolChoice: { name: "lookup" } }));
    expect(captured.tool_choice).toEqual({ type: "tool", name: "lookup" });
  });

  it("implements responseSchema as a single forced tool", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeMessage({
        content: [{ type: "tool_use", id: "call_1", name: "answer", input: { value: 42 }, caller: { type: "direct" } }],
        stop_reason: "tool_use",
      });
    });
    const provider = new AnthropicProvider(client as never);

    const response = await provider.generate(
      baseRequest({ responseSchema: { name: "answer", description: "the answer", schema: { type: "object", properties: { value: { type: "number" } } } } }),
    );

    expect(captured.tools).toEqual([
      { name: "answer", description: "the answer", input_schema: { type: "object", properties: { value: { type: "number" } } } },
    ]);
    expect(captured.tool_choice).toEqual({ type: "tool", name: "answer" });
    expect(response.text).toBe(JSON.stringify({ value: 42 }));
    expect(response.toolCalls).toEqual([]);
  });

  it("defaults maxTokens to 4096 and omits temperature when undefined", async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeClient((params) => {
      captured = params as Record<string, unknown>;
      return fakeMessage();
    });
    const provider = new AnthropicProvider(client as never);

    await provider.generate(baseRequest());
    expect(captured.max_tokens).toBe(4096);
    expect("temperature" in captured).toBe(false);

    await provider.generate(baseRequest({ maxTokens: 100, temperature: 0.5 }));
    expect(captured.max_tokens).toBe(100);
    expect(captured.temperature).toBe(0.5);
  });
});

describe("AnthropicProvider response mapping", () => {
  it("maps text, usage and stop reasons", async () => {
    const client = fakeClient(() =>
      fakeMessage({
        content: [{ type: "text", text: "hello there", citations: null }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 7 } as Anthropic.Usage,
      }),
    );
    const provider = new AnthropicProvider(client as never);
    const response = await provider.generate(baseRequest());

    expect(response.text).toBe("hello there");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(response.stopReason).toBe("end");
    expect(response.provider).toBe("anthropic");
  });

  it("maps tool_use blocks to toolCalls and stop_reason tool_use", async () => {
    const client = fakeClient(() =>
      fakeMessage({
        content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" }, caller: { type: "direct" } }],
        stop_reason: "tool_use",
      }),
    );
    const provider = new AnthropicProvider(client as never);
    const response = await provider.generate(baseRequest());

    expect(response.toolCalls).toEqual([{ type: "tool_call", id: "call_1", name: "lookup", input: { q: "x" } }]);
    expect(response.stopReason).toBe("tool_use");
  });

  it.each([
    ["end_turn", "end"],
    ["stop_sequence", "end"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["pause_turn", "other"],
    ["refusal", "other"],
  ] as const)("maps stop_reason %s to %s", async (anthropicReason, expected) => {
    const client = fakeClient(() => fakeMessage({ stop_reason: anthropicReason }));
    const provider = new AnthropicProvider(client as never);
    const response = await provider.generate(baseRequest());
    expect(response.stopReason).toBe(expected);
  });
});

describe("AnthropicProvider error mapping", () => {
  it("wraps a 429 as a retryable LLMError", async () => {
    const error = new Anthropic.APIError(429, { type: "rate_limit_error", message: "slow down" }, "slow down", new Headers());
    const client = fakeClient(() => {
      throw error;
    });
    const provider = new AnthropicProvider(client as never);

    await expect(provider.generate(baseRequest())).rejects.toBeInstanceOf(LLMError);
    await expect(provider.generate(baseRequest())).rejects.toMatchObject({ provider: "anthropic", retryable: true });
  });

  it("wraps a 500 as retryable and a 400 as non-retryable", async () => {
    const serverError = new Anthropic.APIError(500, { type: "api_error", message: "oops" }, "oops", new Headers());
    let client = fakeClient(() => {
      throw serverError;
    });
    let provider = new AnthropicProvider(client as never);
    await expect(provider.generate(baseRequest())).rejects.toMatchObject({ retryable: true });

    const badRequest = new Anthropic.APIError(400, { type: "invalid_request_error", message: "bad" }, "bad", new Headers());
    client = fakeClient(() => {
      throw badRequest;
    });
    provider = new AnthropicProvider(client as never);
    await expect(provider.generate(baseRequest())).rejects.toMatchObject({ retryable: false });
  });

  it("treats overloaded_error as retryable regardless of status", async () => {
    const overloaded = new Anthropic.APIError(
      529,
      { type: "overloaded_error", message: "overloaded" },
      "overloaded",
      new Headers(),
      "overloaded_error",
    );
    const client = fakeClient(() => {
      throw overloaded;
    });
    const provider = new AnthropicProvider(client as never);
    await expect(provider.generate(baseRequest())).rejects.toMatchObject({ retryable: true });
  });
});
