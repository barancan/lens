import "server-only";

import OpenAI from "openai";
import {
  LLMError,
  type EmbeddingProvider,
  type LLMChunk,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
  type StopReason,
  type TextPart,
  type ToolCallPart,
  type ToolChoice,
  type ToolSpec,
} from "@/lib/llm/types";
import { getOpenAIClient } from "@/lib/providers/openai/client";

/** The subset of the SDK client this adapter depends on — lets tests inject a fake. */
type OpenAIChatClient = { chat: Pick<OpenAI["chat"], "completions"> };
type OpenAIEmbeddingsClient = Pick<OpenAI, "embeddings">;

/**
 * Adapts OpenAI's Chat Completions API to the neutral LLMProvider contract.
 * All OpenAI-specific request/response shapes are confined to this file.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;

  constructor(private readonly client: OpenAIChatClient = getOpenAIClient()) {}

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const params = buildParams(request);
    try {
      const completion = await this.client.chat.completions.create(params, { signal: request.signal });
      return mapResponse(completion as OpenAI.ChatCompletion, this.name);
    } catch (err) {
      throw wrapError(err);
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMChunk> {
    const params = buildParams(request);

    let text = "";
    let stopReason: StopReason = "end";
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let model = request.model;
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

    try {
      const events = (await this.client.chat.completions.create(
        { ...params, stream: true, stream_options: { include_usage: true } },
        { signal: request.signal },
      )) as unknown as AsyncIterable<OpenAI.ChatCompletionChunk>;

      for await (const chunk of events) {
        model = chunk.model || model;
        if (chunk.usage) {
          usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.delta.content) {
          text += choice.delta.content;
          yield { type: "text_delta", text: choice.delta.content };
        }
        for (const delta of choice.delta.tool_calls ?? []) {
          const buffer = toolCallBuffers.get(delta.index) ?? { id: "", name: "", args: "" };
          if (delta.id) buffer.id = delta.id;
          if (delta.function?.name) buffer.name = delta.function.name;
          if (delta.function?.arguments) buffer.args += delta.function.arguments;
          toolCallBuffers.set(delta.index, buffer);
        }
        if (choice.finish_reason) {
          stopReason = mapFinishReason(choice.finish_reason);
        }
      }
    } catch (err) {
      throw wrapError(err);
    }

    const toolCalls: ToolCallPart[] = [];
    for (const buffer of toolCallBuffers.values()) {
      const call: ToolCallPart = { type: "tool_call", id: buffer.id, name: buffer.name, input: parseToolArguments(buffer.args) };
      toolCalls.push(call);
      yield { type: "tool_call", call };
    }

    yield { type: "done", response: { text, toolCalls, stopReason, usage, model, provider: this.name } };
  }
}

/** OpenAI's text-embedding models; only this provider is wired up for now. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai" as const;
  readonly dimensions = 1536;

  constructor(
    private readonly model: string = "text-embedding-3-small",
    private readonly client: OpenAIEmbeddingsClient = getOpenAIClient(),
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    // The API rejects empty strings; substitute a single space to keep positions stable.
    const sanitized = texts.map((text) => (text.length === 0 ? " " : text));
    const results: number[][] = new Array(sanitized.length);
    const batchSize = 100;

    for (let start = 0; start < sanitized.length; start += batchSize) {
      const batch = sanitized.slice(start, start + batchSize);
      try {
        const response = await this.client.embeddings.create({ model: this.model, input: batch });
        for (const item of response.data) {
          results[start + item.index] = item.embedding;
        }
      } catch (err) {
        throw wrapError(err);
      }
    }
    return results;
  }
}

/** Builds the SDK request params shared by generate() and stream(). */
function buildParams(request: LLMRequest): OpenAI.ChatCompletionCreateParamsNonStreaming {
  const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model: request.model,
    messages: mapMessages(request),
    max_completion_tokens: request.maxTokens ?? 4096,
  };
  if (request.temperature !== undefined) params.temperature = request.temperature;

  if (request.responseSchema) {
    params.response_format = {
      type: "json_schema",
      json_schema: {
        name: request.responseSchema.name,
        description: request.responseSchema.description,
        schema: request.responseSchema.schema,
        strict: false,
      },
    };
  } else if (request.tools && request.tools.length > 0) {
    params.tools = mapTools(request.tools);
    const toolChoice = mapToolChoice(request.toolChoice);
    if (toolChoice !== undefined) params.tool_choice = toolChoice;
  }

  return params;
}

function mapTools(tools: ToolSpec[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

function mapToolChoice(choice: ToolChoice | undefined): OpenAI.ChatCompletionToolChoiceOption | undefined {
  if (!choice) return undefined;
  if (choice === "auto") return "auto";
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  return { type: "function", function: { name: choice.name } };
}

function mapMessages(request: LLMRequest): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];
  if (request.system) result.push({ role: "system", content: request.system });

  for (const msg of request.messages) {
    result.push(...mapMessage(msg));
  }
  return result;
}

function mapMessage(msg: LLMMessage): OpenAI.ChatCompletionMessageParam[] {
  if (msg.role === "tool") {
    return msg.content.map((part) => ({
      role: "tool" as const,
      tool_call_id: part.toolCallId,
      content: part.content,
    }));
  }

  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  if (msg.role === "user") {
    const content = msg.content.map((part) => ({ type: "text" as const, text: part.text }));
    return [{ role: "user", content }];
  }

  // Assistant message with mixed text/tool_call parts.
  const textParts = msg.content.filter((part): part is TextPart => part.type === "text");
  const toolParts = msg.content.filter((part): part is ToolCallPart => part.type === "tool_call");
  const text = textParts.map((part) => part.text).join("");

  return [
    {
      role: "assistant",
      content: text.length > 0 ? text : null,
      tool_calls:
        toolParts.length > 0
          ? toolParts.map((part) => ({
              id: part.id,
              type: "function" as const,
              function: { name: part.name, arguments: JSON.stringify(part.input) },
            }))
          : undefined,
    },
  ];
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function mapResponse(completion: OpenAI.ChatCompletion, provider: "openai"): LLMResponse {
  const choice = completion.choices[0];
  const usage: LLMUsage = {
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
  };

  const toolCalls: ToolCallPart[] = (choice?.message.tool_calls ?? [])
    .filter((call): call is OpenAI.ChatCompletionMessageFunctionToolCall => call.type === "function")
    .map((call) => ({
      type: "tool_call" as const,
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    }));

  return {
    text: choice?.message.content ?? "",
    toolCalls,
    stopReason: mapFinishReason(choice?.finish_reason),
    usage,
    model: completion.model,
    provider,
  };
}

/** Wraps SDK errors as LLMError, flagging rate-limit/server errors as retryable. */
function wrapError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;

  const status = err instanceof OpenAI.APIError ? err.status : undefined;
  const retryable = status === 429 || (typeof status === "number" && status >= 500);
  const message = err instanceof Error ? err.message : String(err);
  return new LLMError(message, "openai", retryable, err);
}
