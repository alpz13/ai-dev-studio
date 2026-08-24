/**
 * Traduce herramientas descritas por un servidor MCP (tools.list) al shape
 * que espera el parámetro `tools` de la Messages API de Anthropic. Es lógica
 * pura de datos: no depende de ninguno de los dos SDKs, así se puede probar
 * sola (ver scripts/test-agent-loop-helpers.ts).
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
