/**
 * Pure helpers for the manual agentic loop (Messages API + tool use):
 * splitting text/tool_use blocks out of a response, and building the
 * tool_result block sent back in the next turn. No dependency on any
 * SDK — just the documented content shape of the API.
 */

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export type ContentBlock = ToolUseBlock | TextBlock | { type: string; [key: string]: unknown };

export function extractToolUseBlocks(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

export function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export interface ToolResultForModel {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export function buildToolResultBlock(toolUseId: string, resultText: string, isError = false): ToolResultForModel {
  return { type: "tool_result", tool_use_id: toolUseId, content: resultText, is_error: isError };
}
