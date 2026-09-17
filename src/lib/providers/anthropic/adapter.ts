import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import {
  LLMError,
  type LLMChunk,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
  type StopReason,
  type ToolCallPart,
  type ToolChoice,
} from "@/lib/llm/types";
import { getAnthropicClient } from "@/lib/providers/anthropic/client";

/** The subset of the SDK client this adapter depends on — lets tests inject a fake. */
type AnthropicClient = Pick<Anthropic, "messages">;

/**
 * Adapts Anthropic's Messages API to the neutral LLMProvider contract.
 * All Anthropic-specific request/response shapes are confined to this file.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;

  constructor(private readonly client: AnthropicClient = getAnthropicClient()) {}

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const params = buildCreateParams(request);
    try {
      const message = await this.client.messages.create(params, { signal: request.signal });
      return mapResponse(message, request);
    } catch (err) {
      throw wrapError(err);
    }
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMChunk> {
    const params = buildCreateParams(request);
    const forcedToolName = request.responseSchema?.name;

    let text = "";
    let stopReason: StopReason = "end";
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let model = request.model;
    const toolCalls: ToolCallPart[] = [];
    const pendingToolUse = new Map<number, { id: string; name: string; json: string }>();

    try {
      const events = (await this.client.messages.create(
        { ...params, stream: true },
        { signal: request.signal },
      )) as unknown as AsyncIterable<Anthropic.RawMessageStreamEvent>;

      for await (const event of events) {
        if (event.type === "message_start") {
          model = event.message.model;
          usage = { inputTokens: event.message.usage.input_tokens, outputTokens: event.message.usage.output_tokens };
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          pendingToolUse.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            text += event.delta.text;
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const pending = pendingToolUse.get(event.index);
            if (pending) pending.json += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          const pending = pendingToolUse.get(event.index);
          if (pending) {
            const input = pending.json.length > 0 ? JSON.parse(pending.json) : {};
            if (forcedToolName && pending.name === forcedToolName) {
              text = JSON.stringify(input);
            } else {
              const call: ToolCallPart = { type: "tool_call", id: pending.id, name: pending.name, input };
              toolCalls.push(call);
              yield { type: "tool_call", call };
            }
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) stopReason = mapStopReason(event.delta.stop_reason);
          if (event.usage.input_tokens != null) usage.inputTokens = event.usage.input_tokens;
          usage.outputTokens = event.usage.output_tokens;
        }
      }
    } catch (err) {
      throw wrapError(err);
    }

    const response: LLMResponse = {
      text,
      toolCalls: forcedToolName ? [] : toolCalls,
      stopReason,
      usage,
      model,
      provider: this.name,
    };
    yield { type: "done", response };
  }
}

/** Builds the SDK request params shared by generate() and stream(). */
function buildCreateParams(request: LLMRequest): Anthropic.MessageCreateParamsNonStreaming {
  const { tools, toolChoice } = buildTools(request);

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: request.model,
    max_tokens: request.maxTokens ?? 4096,
    messages: mapMessages(request.messages),
  };
  if (request.system) params.system = request.system;
  if (tools.length > 0) params.tools = tools;
  if (toolChoice) params.tool_choice = toolChoice;
  if (request.temperature !== undefined) params.temperature = request.temperature;
  return params;
}

function buildTools(request: LLMRequest): { tools: Anthropic.Tool[]; toolChoice?: Anthropic.ToolChoice } {
  if (request.responseSchema) {
    const tool: Anthropic.Tool = {
      name: request.responseSchema.name,
      description: request.responseSchema.description ?? "",
      input_schema: request.responseSchema.schema as Anthropic.Tool.InputSchema,
    };
    return { tools: [tool], toolChoice: { type: "tool", name: request.responseSchema.name } };
  }

  const tools = (request.tools ?? []).map(
    (tool): Anthropic.Tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }),
  );
  return { tools, toolChoice: mapToolChoice(request.toolChoice) };
}

function mapToolChoice(choice: ToolChoice | undefined): Anthropic.ToolChoice | undefined {
  if (!choice) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

function mapMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
  return messages.map((msg): Anthropic.MessageParam => {
    if (msg.role === "tool") {
      const content: Anthropic.ToolResultBlockParam[] = msg.content.map((part) => ({
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: part.content,
        is_error: part.isError,
      }));
      return { role: "user", content };
    }

    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content };
    }

    const content: Anthropic.ContentBlockParam[] = msg.content.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text } satisfies Anthropic.TextBlockParam;
      }
      return { type: "tool_use", id: part.id, name: part.name, input: part.input } satisfies Anthropic.ToolUseBlockParam;
    });
    return { role: msg.role, content };
  });
}

function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "other";
  }
}

function mapResponse(message: Anthropic.Message, request: LLMRequest): LLMResponse {
  const usage: LLMUsage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
  const stopReason = mapStopReason(message.stop_reason);

  if (request.responseSchema) {
    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === request.responseSchema!.name,
    );
    return {
      text: toolUse ? JSON.stringify(toolUse.input) : "",
      toolCalls: [],
      stopReason,
      usage,
      model: message.model,
      provider: "anthropic",
    };
  }

  let text = "";
  const toolCalls: ToolCallPart[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({ type: "tool_call", id: block.id, name: block.name, input: block.input });
    }
  }
  return { text, toolCalls, stopReason, usage, model: message.model, provider: "anthropic" };
}

/** Wraps SDK errors as LLMError, flagging rate-limit/server/overloaded errors as retryable. */
function wrapError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;

  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  const errorType = err instanceof Anthropic.APIError ? err.type : undefined;
  const retryable = status === 429 || (typeof status === "number" && status >= 500) || errorType === "overloaded_error";
  const message = err instanceof Error ? err.message : String(err);
  return new LLMError(message, "anthropic", retryable, err);
}
