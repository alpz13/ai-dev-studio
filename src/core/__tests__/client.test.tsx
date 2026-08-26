import { beforeEach, describe, expect, it, vi } from "vitest";

// dotenv/config is a side-effect import (reads .env from disk);
// we no-op it so the test doesn't depend on a real .env existing.
vi.mock("dotenv/config", () => ({}));

const createMock = vi.fn();
const streamMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      messages: {
        create: createMock,
        stream: streamMock,
      },
    };
  }),
}));

const { sendMessage, streamMessage } = await import("../../core/client.js");

describe("core/client", () => {
  beforeEach(() => {
    createMock.mockReset();
    streamMock.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  describe("sendMessage", () => {
    it("sends the prompt as a user message and returns the response's text block", async () => {
      createMock.mockResolvedValue({ content: [{ type: "text", text: "hi" }] });

      const result = await sendMessage("say hi");

      expect(result).toBe("hi");
      expect(createMock).toHaveBeenCalledTimes(1);
      const callArgs = createMock.mock.calls[0][0];
      expect(callArgs.messages).toEqual([{ role: "user", content: "say hi" }]);
    });

    it("returns an empty string if the response has no text block", async () => {
      createMock.mockResolvedValue({ content: [{ type: "tool_use", id: "x", name: "y", input: {} }] });

      const result = await sendMessage("something");

      expect(result).toBe("");
    });

    it("passes model, system, and maxTokens to the SDK when given as options", async () => {
      createMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

      await sendMessage("hi", { model: "custom-model", system: "you are a test", maxTokens: 42 });

      const callArgs = createMock.mock.calls[0][0];
      expect(callArgs.model).toBe("custom-model");
      expect(callArgs.system).toBe("you are a test");
      expect(callArgs.max_tokens).toBe(42);
    });

    it("uses 1024 as the default max_tokens", async () => {
      createMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

      await sendMessage("hi");

      expect(createMock.mock.calls[0][0].max_tokens).toBe(1024);
    });
  });

  describe("streamMessage", () => {
    it("calls onDelta for each emitted chunk and returns the final text", async () => {
      const handlers: Record<string, (chunk: string) => void> = {};
      streamMock.mockReturnValue({
        on: (event: string, handler: (chunk: string) => void) => {
          handlers[event] = handler;
        },
        finalMessage: async () => {
          handlers.text?.("hi ");
          handlers.text?.("world");
          return { content: [{ type: "text", text: "hi world" }] };
        },
      });

      const chunks: string[] = [];
      const result = await streamMessage("greet", (chunk) => chunks.push(chunk));

      expect(chunks).toEqual(["hi ", "world"]);
      expect(result).toBe("hi world");
    });

    it("returns an empty string if the final message has no text block", async () => {
      streamMock.mockReturnValue({
        on: () => {},
        finalMessage: async () => ({ content: [] }),
      });

      const result = await streamMessage("something", () => {});

      expect(result).toBe("");
    });
  });
});
