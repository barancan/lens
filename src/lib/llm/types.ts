/**
 * Provider-neutral LLM contract. Business logic depends only on these types;
 * SDK-specific formats live exclusively in `src/lib/providers/<name>/`.
 */

export type ProviderName = "anthropic" | "openai" | "bios" | "local";

export interface ModelRef {
  provider: ProviderName;
  model: string;
}

export type JSONSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) describing the tool input. */
  inputSchema: JSONSchema;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  /** JSON-serialisable or plain-text result content. */
  content: string;
  isError?: boolean;
}

export type LLMMessage =
  | { role: "user"; content: string | TextPart[] }
  | { role: "assistant"; content: string | (TextPart | ToolCallPart)[] }
  | { role: "tool"; content: ToolResultPart[] };

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export interface LLMRequest {
  model: string;
  system?: string;
  messages: LLMMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  /**
   * Ask for a JSON object matching this schema. Adapters implement this natively
   * (OpenAI: response_format json_schema; Anthropic: a forced tool call) and
   * return the JSON as `text`. Mutually exclusive with `tools`.
   */
  responseSchema?: { name: string; description?: string; schema: JSONSchema };
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "other";

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  /** Concatenated assistant text (or the JSON string when responseSchema is used). */
  text: string;
  toolCalls: ToolCallPart[];
  stopReason: StopReason;
  usage: LLMUsage;
  model: string;
  provider: ProviderName;
}

export type LLMChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCallPart }
  | { type: "done"; response: LLMResponse };

export interface LLMProvider {
  readonly name: ProviderName;
  generate(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest): AsyncIterable<LLMChunk>;
}

export interface EmbeddingProvider {
  readonly name: ProviderName;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly retryable = false,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
    readonly issues: unknown,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}
