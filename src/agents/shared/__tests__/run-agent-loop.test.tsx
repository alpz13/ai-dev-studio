import { beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop, type AnthropicMessagesClient, type McpToolsClient, type TraceLoggerLike } from "../../../agents/shared/run-agent-loop.js";
import type { TraceEventInput } from "../../../observability/trace-logger.js";

// Este motor recibe `anthropic` y `mcpClient` inyectados (ver el comentario
// en el archivo fuente), así que se puede probar con objetos planos que
// cumplan el shape mínimo — sin vi.mock, sin instalar ningún SDK.

function fakeTraceLogger(): TraceLoggerLike & { events: TraceEventInput[] } {
  const events: TraceEventInput[] = [];
  return {
    events,
    log: async (event) => {
      events.push(event);
      return event;
    },
  };
}

function textResponse(text: string) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" as const };
}

function toolUseResponse(id: string, name: string, input: unknown) {
  return { content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" as const };
}

const traceCtx = { traceId: "feat_test", spanId: "agt_1", agentRole: "TestRole" };

describe("agents/shared/run-agent-loop", () => {
  let mcpClient: McpToolsClient & { calls: Array<{ name: string; arguments: Record<string, unknown> }> };

  beforeEach(() => {
    mcpClient = {
      calls: [],
      listTools: async () => ({
        tools: [{ name: "write_file", description: "Escribe un archivo", inputSchema: { type: "object" } }],
      }),
      callTool: async (input) => {
        mcpClient.calls.push(input);
        return { content: [{ text: "Escrito: hello.txt" }], isError: false };
      },
    };
  });

  it("camino feliz: una tool call y luego respuesta final, con tool_call/tool_result logueados en orden", async () => {
    let call = 0;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          call++;
          return call === 1
            ? toolUseResponse("toolu_1", "write_file", { path: "hello.txt", content: "hola" })
            : textResponse("Listo, creé hello.txt.");
        },
      },
    };
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "system de prueba",
      task: "crea hello.txt",
      traceLogger,
      traceCtx,
    });

    expect(result).toBe("Listo, creé hello.txt.");
    expect(mcpClient.calls).toEqual([{ name: "write_file", arguments: { path: "hello.txt", content: "hola" } }]);
    expect(traceLogger.events.map((e) => e.event)).toEqual(["tool_call", "tool_result"]);
    expect(traceLogger.events[0].traceId).toBe("feat_test");
    expect(traceLogger.events[0].agentRole).toBe("TestRole");
  });

  it("responde de una sin pedir tools si el primer turno ya es la respuesta final (no loguea nada)", async () => {
    const anthropic: AnthropicMessagesClient = {
      messages: { create: async () => textResponse("No hace falta tocar archivos.") },
    };
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "system",
      task: "solo responde",
      traceLogger,
      traceCtx,
    });

    expect(result).toBe("No hace falta tocar archivos.");
    expect(mcpClient.calls).toEqual([]);
    expect(traceLogger.events).toEqual([]);
  });

  it("un error de la tool se loguea como isError y el loop sigue hasta la respuesta final", async () => {
    let call = 0;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          call++;
          return call === 1
            ? toolUseResponse("toolu_1", "write_file", { path: "../fuera.txt", content: "x" })
            : textResponse("Corregido.");
        },
      },
    };
    mcpClient.callTool = async () => {
      throw new Error("Ruta fuera del workspace permitido");
    };
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "system",
      task: "intenta algo inválido",
      traceLogger,
      traceCtx,
    });

    expect(result).toBe("Corregido.");
    const toolResult = traceLogger.events.find((e) => e.event === "tool_result");
    expect(toolResult?.isError).toBe(true);
    expect(String(toolResult?.output)).toMatch(/fuera del workspace/);
  });

  it("respeta maxTurns y devuelve string vacío si el modelo nunca deja de pedir tools", async () => {
    let calls = 0;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          calls++;
          return toolUseResponse(`toolu_${calls}`, "write_file", { path: "a.txt", content: "x" });
        },
      },
    };
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "system",
      task: "nunca termina",
      traceLogger,
      traceCtx,
      maxTurns: 3,
    });

    expect(result).toBe("");
    expect(calls).toBe(3);
  });

  it("traduce las tools del MCP a tools de Anthropic en cada llamada a create", async () => {
    let receivedTools: unknown;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async (params) => {
          receivedTools = params.tools;
          return textResponse("listo");
        },
      },
    };

    await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "system",
      task: "algo",
      traceLogger: fakeTraceLogger(),
      traceCtx,
    });

    expect(receivedTools).toEqual([
      { name: "write_file", description: "Escribe un archivo", input_schema: { type: "object" } },
    ]);
  });

  it("usa el system prompt y el task dados en el primer mensaje", async () => {
    let receivedSystem: string | undefined;
    let receivedMessages: unknown;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async (params) => {
          receivedSystem = params.system;
          // Ojo: `messages` es el mismo array que el loop sigue mutando
          // después de este `create()` (le hace push de la respuesta del
          // assistant antes de romper el loop) — hay que copiarlo acá, si
          // no `receivedMessages` "ve" ese push posterior por referencia.
          receivedMessages = [...params.messages];
          return textResponse("ok");
        },
      },
    };

    await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "Eres un agente de prueba.",
      task: "haz algo puntual",
      traceLogger: fakeTraceLogger(),
      traceCtx,
    });

    expect(receivedSystem).toBe("Eres un agente de prueba.");
    expect(receivedMessages).toEqual([{ role: "user", content: "haz algo puntual" }]);
  });
});
