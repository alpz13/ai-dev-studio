import { describe, expect, it } from "vitest";
import {
  buildToolResultBlock,
  extractText,
  extractToolUseBlocks,
  type ContentBlock,
} from "../../../agents/shared/agent-loop-helpers.js";

describe("agents/shared/agent-loop-helpers", () => {
  const mixedContent: ContentBlock[] = [
    { type: "text", text: "Voy a revisar el estado del repo primero." },
    { type: "tool_use", id: "toolu_1", name: "git_status", input: {} },
    { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "hello.txt" } },
  ];

  describe("extractToolUseBlocks", () => {
    it("extrae solo los bloques tool_use, en orden", () => {
      const toolUses = extractToolUseBlocks(mixedContent);

      expect(toolUses).toHaveLength(2);
      expect(toolUses.map((t) => t.name)).toEqual(["git_status", "read_file"]);
    });

    it("devuelve [] cuando no hay tool_use", () => {
      expect(extractToolUseBlocks([{ type: "text", text: "listo" }])).toEqual([]);
    });
  });

  describe("extractText", () => {
    it("concatena solo los bloques de texto", () => {
      expect(extractText(mixedContent)).toBe("Voy a revisar el estado del repo primero.");
    });

    it("une varios bloques de texto con salto de línea", () => {
      const content: ContentBlock[] = [
        { type: "text", text: "línea 1" },
        { type: "text", text: "línea 2" },
      ];

      expect(extractText(content)).toBe("línea 1\nlínea 2");
    });

    it("devuelve string vacío si no hay texto", () => {
      expect(extractText([{ type: "tool_use", id: "x", name: "y", input: {} }])).toBe("");
    });
  });

  describe("buildToolResultBlock", () => {
    it("arma un tool_result exitoso por default (is_error: false)", () => {
      const block = buildToolResultBlock("toolu_1", "(sin cambios pendientes)");

      expect(block).toEqual({
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "(sin cambios pendientes)",
        is_error: false,
      });
    });

    it("arma un tool_result de error cuando se pide", () => {
      const block = buildToolResultBlock("toolu_2", "Ruta fuera del workspace permitido", true);

      expect(block.is_error).toBe(true);
    });
  });
});
