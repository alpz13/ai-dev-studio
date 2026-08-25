import { beforeEach, describe, expect, it, vi } from "vitest";

// dotenv/config es un import de efecto secundario (lee .env del disco);
// lo noopeamos para que el test no dependa de que exista un .env real.
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
    it("envía el prompt como mensaje de usuario y devuelve el bloque de texto de la respuesta", async () => {
      createMock.mockResolvedValue({ content: [{ type: "text", text: "hola" }] });

      const result = await sendMessage("di hola");

      expect(result).toBe("hola");
      expect(createMock).toHaveBeenCalledTimes(1);
      const callArgs = createMock.mock.calls[0][0];
      expect(callArgs.messages).toEqual([{ role: "user", content: "di hola" }]);
    });

    it("devuelve string vacío si la respuesta no trae ningún bloque de texto", async () => {
      createMock.mockResolvedValue({ content: [{ type: "tool_use", id: "x", name: "y", input: {} }] });

      const result = await sendMessage("algo");

      expect(result).toBe("");
    });

    it("pasa model, system y maxTokens al SDK cuando se dan como opciones", async () => {
      createMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

      await sendMessage("hola", { model: "modelo-custom", system: "eres un test", maxTokens: 42 });

      const callArgs = createMock.mock.calls[0][0];
      expect(callArgs.model).toBe("modelo-custom");
      expect(callArgs.system).toBe("eres un test");
      expect(callArgs.max_tokens).toBe(42);
    });

    it("usa 1024 como max_tokens por default", async () => {
      createMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

      await sendMessage("hola");

      expect(createMock.mock.calls[0][0].max_tokens).toBe(1024);
    });
  });

  describe("streamMessage", () => {
    it("llama onDelta por cada chunk emitido y devuelve el texto final", async () => {
      const handlers: Record<string, (chunk: string) => void> = {};
      streamMock.mockReturnValue({
        on: (event: string, handler: (chunk: string) => void) => {
          handlers[event] = handler;
        },
        finalMessage: async () => {
          handlers.text?.("hola ");
          handlers.text?.("mundo");
          return { content: [{ type: "text", text: "hola mundo" }] };
        },
      });

      const chunks: string[] = [];
      const result = await streamMessage("saluda", (chunk) => chunks.push(chunk));

      expect(chunks).toEqual(["hola ", "mundo"]);
      expect(result).toBe("hola mundo");
    });

    it("devuelve string vacío si el mensaje final no trae bloque de texto", async () => {
      streamMock.mockReturnValue({
        on: () => {},
        finalMessage: async () => ({ content: [] }),
      });

      const result = await streamMessage("algo", () => {});

      expect(result).toBe("");
    });
  });
});
