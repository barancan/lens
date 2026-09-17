import { z } from "zod";
import { StructuredOutputError, type LLMProvider, type LLMRequest, type LLMResponse, type LLMUsage } from "@/lib/llm/types";

export interface StructuredOutputSpec<T> {
  name: string;
  description?: string;
  schema: z.ZodType<T>;
}

export interface StructuredResult<T> {
  data: T;
  response: LLMResponse;
  attempts: number;
}

/**
 * Calls a provider asking for JSON matching `output.schema` (via the neutral
 * `responseSchema` request field, which each adapter implements natively).
 * Validates the result; on failure, makes exactly one repair attempt by
 * sending the invalid output back along with the validation issues.
 */
export async function generateStructured<T>(
  provider: LLMProvider,
  request: Omit<LLMRequest, "responseSchema" | "tools" | "toolChoice">,
  output: StructuredOutputSpec<T>,
): Promise<StructuredResult<T>> {
  const schema = toJsonSchema(output.schema);
  const initialRequest: LLMRequest = {
    ...request,
    responseSchema: { name: output.name, description: output.description, schema },
  };

  const response = await provider.generate(initialRequest);
  const firstAttempt = tryParse(output.schema, response.text);
  if (firstAttempt.ok) {
    return { data: firstAttempt.data, response, attempts: 1 };
  }

  const repairRequest: LLMRequest = {
    ...initialRequest,
    messages: [
      ...initialRequest.messages,
      { role: "assistant", content: response.text },
      {
        role: "user",
        content: `Your last response was not valid JSON matching the required schema.\n\nIssues:\n${firstAttempt.issues}\n\nRespond with corrected JSON only — no prose, no code fences.`,
      },
    ],
  };
  const repairResponse = await provider.generate(repairRequest);
  const secondAttempt = tryParse(output.schema, repairResponse.text);
  if (secondAttempt.ok) {
    return {
      data: secondAttempt.data,
      response: { ...repairResponse, usage: sumUsage(response.usage, repairResponse.usage) },
      attempts: 2,
    };
  }

  throw new StructuredOutputError(
    `Failed to produce valid structured output for "${output.name}" after a repair attempt`,
    repairResponse.text,
    secondAttempt.issues,
  );
}

export function sumUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/** zod's JSON Schema output includes a top-level $schema key that providers don't expect. */
function toJsonSchema<T>(schema: z.ZodType<T>): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

/** Parses `text` as JSON, tolerating a ```json ... ``` fence around it. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

type ParseAttempt<T> = { ok: true; data: T } | { ok: false; issues: string };

function tryParse<T>(schema: z.ZodType<T>, text: string): ParseAttempt<T> {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (err) {
    return { ok: false, issues: `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, issues: z.prettifyError(parsed.error) };
}
