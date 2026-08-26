import { describe, expect, it } from "vitest";
import { mcpToolToAnthropicTool, mcpToolsToAnthropicTools } from "../../../agents/shared/mcp-tool-adapter.js";

describe("agents/shared/mcp-tool-adapter", () => {
  it("mcpToolToAnthropicTool preserves name, description, and input_schema", () => {
    const tool = mcpToolToAnthropicTool({
      name: "write_file",
      description: "Writes a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    });

    expect(tool).toEqual({
      name: "write_file",
      description: "Writes a file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    });
  });

  it("a tool without a description must not end up undefined (Anthropic requires a string)", () => {
    const tool = mcpToolToAnthropicTool({ name: "git_status", inputSchema: { type: "object" } });

    expect(tool.description).toBe("");
  });

  it("mcpToolsToAnthropicTools maps a full list, preserving order", () => {
    const tools = mcpToolsToAnthropicTools([
      { name: "a", description: "A", inputSchema: {} },
      { name: "b", description: "B", inputSchema: {} },
    ]);

    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("mcpToolsToAnthropicTools of an empty list returns []", () => {
    expect(mcpToolsToAnthropicTools([])).toEqual([]);
  });
});
