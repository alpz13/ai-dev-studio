/**
 * Helpers puros para el loop agentic manual (Messages API + tool use):
 * separar bloques de texto/tool_use de una respuesta, y armar el bloque
 * tool_result que se manda de vuelta en el siguiente turno. Sin depender
 * de ningún SDK — solo del shape de contenido documentado de la API.
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
