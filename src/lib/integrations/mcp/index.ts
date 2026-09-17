/**
 * Minimal MCP (Model Context Protocol) tool-server contract.
 *
 * This is intentionally not an implementation — just the shape a future MCP
 * client adapter would expose. Once a real MCP client is wired up, each
 * remote tool listed by `listTools()` will be adapted into an `AgentTool`
 * (see `src/lib/tools/types.ts`): the tool's JSON schema becomes
 * `AgentTool.schema` (via `z.toJSONSchema`/a JSON-schema-to-zod bridge, or by
 * validating loosely and delegating real validation to the MCP server), and
 * `AgentTool.execute(input, ctx)` becomes a thin wrapper that calls
 * `callTool(name, input)` and maps the result into `ToolResult`. No such
 * adapter exists yet; this file only documents the target shape.
 */

export interface McpToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input, as advertised by the MCP server. */
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  isError?: boolean;
  content: unknown;
}

export interface McpToolServer {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, input: unknown): Promise<McpToolResult>;
}
