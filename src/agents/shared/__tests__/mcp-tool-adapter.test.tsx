import { describe, expect, it } from "vitest";
import { mcpToolToAnthropicTool, mcpToolsToAnthropicTools } from "../../../agents/shared/mcp-tool-adapter.js";

describe("agents/shared/mcp-tool-adapter", () => {
  it("mcpToolToAnthropicTool conserva name, description e input_schema", () => {
    const tool = mcpToolToAnthropicTool({
      name: "write_file",
      description: "Escribe un archivo",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    });

    expect(tool).toEqual({
      name: "write_file",
      description: "Escribe un archivo",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    });
  });

  it("una tool sin description no debe quedar undefined (Anthropic requiere string)", () => {
    const tool = mcpToolToAnthropicTool({ name: "git_status", inputSchema: { type: "object" } });

    expect(tool.description).toBe("");
  });

  it("mcpToolsToAnthropicTools mapea una lista completa, preservando el orden", () => {
    const tools = mcpToolsToAnthropicTools([
      { name: "a", description: "A", inputSchema: {} },
      { name: "b", description: "B", inputSchema: {} },
    ]);

    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("mcpToolsToAnthropicTools de una lista vacía devuelve []", () => {
    expect(mcpToolsToAnthropicTools([])).toEqual([]);
  });
});
