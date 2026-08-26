import { describe, expect, it } from "vitest";
import {
  buildToolResultBlock,
  extractText,
  extractToolUseBlocks,
  type ContentBlock,
} from "../../../agents/shared/agent-loop-helpers.js";

describe("agents/shared/agent-loop-helpers", () => {
  const mixedContent: ContentBlock[] = [
    { type: "text", text: "I'll check the repo status first." },
    { type: "tool_use", id: "toolu_1", name: "git_status", input: {} },
    { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "hello.txt" } },
  ];

  describe("extractToolUseBlocks", () => {
    it("extracts only the tool_use blocks, in order", () => {
      const toolUses = extractToolUseBlocks(mixedContent);

      expect(toolUses).toHaveLength(2);
      expect(toolUses.map((t) => t.name)).toEqual(["git_status", "read_file"]);
    });

    it("returns [] when there is no tool_use", () => {
      expect(extractToolUseBlocks([{ type: "text", text: "done" }])).toEqual([]);
    });
  });

  describe("extractText", () => {
    it("concatenates only the text blocks", () => {
      expect(extractText(mixedContent)).toBe("I'll check the repo status first.");
    });

    it("joins several text blocks with a line break", () => {
      const content: ContentBlock[] = [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ];

      expect(extractText(content)).toBe("line 1\nline 2");
    });

    it("returns an empty string if there is no text", () => {
      expect(extractText([{ type: "tool_use", id: "x", name: "y", input: {} }])).toBe("");
    });
  });

  describe("buildToolResultBlock", () => {
    it("builds a successful tool_result by default (is_error: false)", () => {
      const block = buildToolResultBlock("toolu_1", "(no pending changes)");

      expect(block).toEqual({
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "(no pending changes)",
        is_error: false,
      });
    });

    it("builds an error tool_result when requested", () => {
      const block = buildToolResultBlock("toolu_2", "Path outside the allowed workspace", true);

      expect(block.is_error).toBe(true);
    });
  });
});
