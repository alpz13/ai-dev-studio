/**
 * Smoke test for the pure logic of the agentic loop: the MCP→Anthropic
 * tool adapter and the content-block extraction/building helpers.
 * Usage: tsx scripts/test-agent-loop-helpers.ts
 */
import assert from "node:assert/strict";
import { mcpToolsToAnthropicTools } from "../src/agents/shared/mcp-tool-adapter.js";
import {
  buildToolResultBlock,
  extractText,
  extractToolUseBlocks,
  type ContentBlock,
} from "../src/agents/shared/agent-loop-helpers.js";

async function main() {
  // 1. Tool adapter: name/description/schema map 1:1, and a tool with no
  //    description must not break the mapping (Anthropic requires a string).
  const mcpTools = [
    { name: "write_file", description: "Writes a file", inputSchema: { type: "object" } },
    { name: "git_status", description: undefined, inputSchema: { type: "object" } },
  ];
  const anthropicTools = mcpToolsToAnthropicTools(mcpTools);
  assert.equal(anthropicTools.length, 2);
  assert.equal(anthropicTools[0].name, "write_file");
  assert.equal(anthropicTools[0].description, "Writes a file");
  assert.equal(anthropicTools[1].description, "", "a tool with no description should end up as an empty string, not undefined");

  // 2. extractToolUseBlocks / extractText correctly split a mixed response
  //    (text + one or more tool_use blocks).
  const mixedContent: ContentBlock[] = [
    { type: "text", text: "I'll check the repo status first." },
    { type: "tool_use", id: "toolu_1", name: "git_status", input: {} },
    { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "hello.txt" } },
  ];
  const toolUses = extractToolUseBlocks(mixedContent);
  assert.equal(toolUses.length, 2);
  assert.equal(toolUses[0].name, "git_status");
  assert.equal(toolUses[1].input && (toolUses[1].input as { path: string }).path, "hello.txt");
  assert.equal(extractText(mixedContent), "I'll check the repo status first.");

  // 3. A text-only response (final turn) must not carry any tool_use.
  const finalContent: ContentBlock[] = [{ type: "text", text: "Done, committed hello.txt." }];
  assert.equal(extractToolUseBlocks(finalContent).length, 0);
  assert.equal(extractText(finalContent), "Done, committed hello.txt.");

  // 4. buildToolResultBlock builds the shape the API expects for the next
  //    turn, including the error case.
  const okResult = buildToolResultBlock("toolu_1", "(no pending changes)");
  assert.equal(okResult.type, "tool_result");
  assert.equal(okResult.tool_use_id, "toolu_1");
  assert.equal(okResult.is_error, false);

  const errResult = buildToolResultBlock("toolu_2", "Path outside the allowed workspace", true);
  assert.equal(errResult.is_error, true);

  console.log("✅ Tool adapter and agentic loop helpers: all correct.");
  console.log("   - MCP → Anthropic tool mapping preserves name/description/input_schema");
  console.log("   - splitting text vs tool_use blocks works for mixed and final responses");
  console.log("   - buildToolResultBlock builds the correct shape, including is_error");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
