/**
 * Translates tools described by an MCP server (tools.list) into the shape
 * expected by the `tools` parameter of Anthropic's Messages API. This is
 * pure data logic: it doesn't depend on either SDK, so it can be tested
 * in isolation (see scripts/agent-loop-helpers.test.ts).
 */

export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: unknown;
}

export function mcpToolToAnthropicTool(tool: McpToolLike): AnthropicToolDef {
  return {
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema,
  };
}

export function mcpToolsToAnthropicTools(tools: McpToolLike[]): AnthropicToolDef[] {
  return tools.map(mcpToolToAnthropicTool);
}
