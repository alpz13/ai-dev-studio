/**
 * Prueba de humo de la lógica pura del loop agentic: el adaptador de tools
 * MCP→Anthropic y los helpers de extracción/armado de bloques de contenido.
 * Uso: tsx scripts/test-agent-loop-helpers.ts
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
  // 1. Adaptador de tools: nombre/descripción/schema se mapean 1:1, y una
  //    tool sin descripción no debe romper el mapeo (Anthropic requiere string).
  const mcpTools = [
    { name: "write_file", description: "Escribe un archivo", inputSchema: { type: "object" } },
    { name: "git_status", description: undefined, inputSchema: { type: "object" } },
  ];
  const anthropicTools = mcpToolsToAnthropicTools(mcpTools);
  assert.equal(anthropicTools.length, 2);
  assert.equal(anthropicTools[0].name, "write_file");
  assert.equal(anthropicTools[0].description, "Escribe un archivo");
  assert.equal(anthropicTools[1].description, "", "una tool sin description debe quedar como string vacío, no undefined");

  // 2. extractToolUseBlocks / extractText separan correctamente una
  //    respuesta mixta (texto + una o más tool_use).
  const mixedContent: ContentBlock[] = [
    { type: "text", text: "Voy a revisar el estado del repo primero." },
    { type: "tool_use", id: "toolu_1", name: "git_status", input: {} },
    { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "hello.txt" } },
  ];
  const toolUses = extractToolUseBlocks(mixedContent);
  assert.equal(toolUses.length, 2);
  assert.equal(toolUses[0].name, "git_status");
  assert.equal(toolUses[1].input && (toolUses[1].input as { path: string }).path, "hello.txt");
  assert.equal(extractText(mixedContent), "Voy a revisar el estado del repo primero.");

  // 3. Una respuesta solo de texto (turno final) no debe traer tool_use.
  const finalContent: ContentBlock[] = [{ type: "text", text: "Listo, hice commit de hello.txt." }];
  assert.equal(extractToolUseBlocks(finalContent).length, 0);
  assert.equal(extractText(finalContent), "Listo, hice commit de hello.txt.");

  // 4. buildToolResultBlock arma el shape que la API espera para el
  //    siguiente turno, incluyendo el caso de error.
  const okResult = buildToolResultBlock("toolu_1", "(sin cambios pendientes)");
  assert.equal(okResult.type, "tool_result");
  assert.equal(okResult.tool_use_id, "toolu_1");
  assert.equal(okResult.is_error, false);

  const errResult = buildToolResultBlock("toolu_2", "Ruta fuera del workspace permitido", true);
  assert.equal(errResult.is_error, true);

  console.log("✅ Adaptador de tools y helpers del loop agentic: todo correcto.");
  console.log("   - mapeo de tools MCP → Anthropic conserva name/description/input_schema");
  console.log("   - separación de bloques texto vs tool_use funciona en respuestas mixtas y finales");
  console.log("   - buildToolResultBlock arma el shape correcto, incluyendo is_error");
}

main().catch((err) => {
  console.error("❌ Falló la prueba:", err);
  process.exit(1);
});
