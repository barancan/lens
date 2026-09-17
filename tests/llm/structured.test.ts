import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured, sumUsage } from "@/lib/llm/structured";
import { StructuredOutputError, type LLMProvider, type LLMRequest, type LLMResponse } from "@/lib/llm/types";

const schema = z.object({ answer: z.number() });

function baseRequest(): Omit<LLMRequest, "responseSchema" | "tools" | "toolChoice"> {
  return { model: "test-model", messages: [{ role: "user", content: "what is 2+2?" }] };
}

function fakeResponse(text: string, stopReason: LLMResponse["stopReason"] = "end"): LLMResponse {
  return { text, toolCalls: [], stopReason, usage: { inputTokens: 1, outputTokens: 1 }, model: "test-model", provider: "anthropic" };
}

function fakeProvider(generate: (request: LLMRequest) => Promise<LLMResponse>): LLMProvider {
  return { name: "anthropic", generate };
}

describe("generateStructured", () => {
  it("succeeds on the first valid attempt", async () => {
    const generate = vi.fn(async (_request: LLMRequest) => fakeResponse('{"answer":4}'));
    const provider = fakeProvider(generate);

    const result = await generateStructured(provider, baseRequest(), { name: "answer", schema });

    expect(result.data).toEqual({ answer: 4 });
    expect(result.attempts).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);

    // The forced-tool request shape is passed through to the provider.
    const request = generate.mock.calls[0]![0];
    expect(request.responseSchema?.name).toBe("answer");
    expect(request.tools).toBeUndefined();
  });

  it("tolerates a ```json fence around the JSON", async () => {
    const generate = vi.fn(async () => fakeResponse('```json\n{"answer":4}\n```'));
    const provider = fakeProvider(generate);

    const result = await generateStructured(provider, baseRequest(), { name: "answer", schema });

    expect(result.data).toEqual({ answer: 4 });
    expect(result.attempts).toBe(1);
  });

  it("repairs an invalid first attempt", async () => {
    let call = 0;
    const generate = vi.fn(async (request: LLMRequest) => {
      call += 1;
      if (call === 1) return fakeResponse('{"answer":"not a number"}');
      // Second call should include the bad output and a repair instruction.
      const lastMessage = request.messages[request.messages.length - 1];
      expect(typeof lastMessage?.content === "string" && lastMessage.content.includes("Issues")).toBe(true);
      return fakeResponse('{"answer":4}');
    });
    const provider = fakeProvider(generate);

    const result = await generateStructured(provider, baseRequest(), { name: "answer", schema });

    expect(result.data).toEqual({ answer: 4 });
    expect(result.attempts).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("repairs a response cut off at max_tokens even when its prefix validates, telling the model it was truncated", async () => {
    let call = 0;
    const generate = vi.fn(async (request: LLMRequest) => {
      call += 1;
      // A forced tool call truncated by max_tokens comes back as the well-formed prefix of the object.
      if (call === 1) return fakeResponse('{"answer":4}', "max_tokens");
      const lastMessage = request.messages[request.messages.length - 1];
      const content = typeof lastMessage?.content === "string" ? lastMessage.content : "";
      expect(content).toMatch(/cut off by the output token limit/);
      expect(content).toContain("valid but incomplete");
      return fakeResponse('{"answer":4}');
    });
    const provider = fakeProvider(generate);

    const result = await generateStructured(provider, baseRequest(), { name: "answer", schema });

    expect(result.data).toEqual({ answer: 4 });
    expect(result.attempts).toBe(2);
  });

  it("keeps a valid but truncated repair rather than discarding it", async () => {
    const generate = vi.fn(async () => fakeResponse('{"answer":4}', "max_tokens"));
    const provider = fakeProvider(generate);

    const result = await generateStructured(provider, baseRequest(), { name: "answer", schema });

    expect(result.data).toEqual({ answer: 4 });
    expect(result.attempts).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("throws StructuredOutputError when both attempts fail", async () => {
    const generate = vi.fn(async () => fakeResponse("not json at all"));
    const provider = fakeProvider(generate);

    await expect(generateStructured(provider, baseRequest(), { name: "answer", schema })).rejects.toBeInstanceOf(StructuredOutputError);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});

describe("sumUsage", () => {
  it("adds input and output tokens", () => {
    expect(sumUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 })).toEqual({
      inputTokens: 4,
      outputTokens: 6,
    });
  });
});
