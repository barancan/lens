import { z } from "zod";
import type { ToolSpec } from "@/lib/llm/types";

/** Context passed to every tool execution (for logging & provenance). */
export interface ToolContext {
  runId: string | null;
  taskId: string | null;
}

export type ToolResult<O = unknown> = { ok: true; data: O } | { ok: false; error: string };

export interface AgentTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

/** Identity helper that infers the tool's input type from its schema. */
export function defineTool<I, O>(tool: AgentTool<I, O>): AgentTool<I, O> {
  return tool;
}

/** Heterogeneous tool lists are held as AgentTool<any>; inputs are validated at invocation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any, unknown>;

export function toToolSpec(tool: AnyAgentTool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema, { io: "input" }) as Record<string, unknown>,
  };
}

/** Validate input and execute a tool, never throwing. */
export async function invokeTool(tool: AnyAgentTool, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input for ${tool.name}: ${z.prettifyError(parsed.error)}` };
  }
  try {
    return await tool.execute(parsed.data, ctx);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
