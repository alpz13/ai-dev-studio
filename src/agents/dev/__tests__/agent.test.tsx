import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: createMock } };
  }),
}));

const connectMock = vi.fn().mockResolvedValue(undefined);
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
const closeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function () {
    return {
      connect: connectMock,
      listTools: listToolsMock,
      callTool: callToolMock,
      close: closeMock,
    };
  }),
}));

let lastTransportOpts: { command: string; args: string[]; env?: Record<string, string> } | undefined;
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (opts) {
    lastTransportOpts = opts;
    return { __opts: opts };
  }),
}));

const { runDevAgent } = await import("../agent.js");
const { TraceLogger } = await import("../../../observability/trace-logger.js");

function textResponse(text: string) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" };
}

function toolUseResponse(toolUseId: string, name: string, input: unknown) {
  return { content: [{ type: "tool_use", id: toolUseId, name, input }], stop_reason: "tool_use" };
}

describe("agents/dev/agent: runDevAgent", () => {
  let logsDir: string;
  const featureId = "feat_test_dev-agent";

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-agent-test-"));
    process.env.LOGS_DIR = logsDir;
    process.env.ANTHROPIC_API_KEY = "test-key";

    createMock.mockReset();
    listToolsMock.mockReset();
    callToolMock.mockReset();
    closeMock.mockClear();
    connectMock.mockClear();
    lastTransportOpts = undefined;

    listToolsMock.mockResolvedValue({
      tools: [{ name: "write_file", description: "Escribe un archivo", inputSchema: { type: "object" } }],
    });
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("camino feliz: una tool call y luego la respuesta final, todo queda logueado en orden", async () => {
    createMock
      .mockResolvedValueOnce(toolUseResponse("toolu_1", "write_file", { path: "hello.txt", content: "hola" }))
      .mockResolvedValueOnce(textResponse("Listo, creé hello.txt."));
    callToolMock.mockResolvedValueOnce({ content: [{ type: "text", text: "Escrito: hello.txt" }], isError: false });

    const summary = await runDevAgent({ featureId, task: "crea hello.txt", workspaceRoot: `workspaces/${featureId}` });

    expect(summary).toBe("Listo, creé hello.txt.");
    expect(callToolMock).toHaveBeenCalledWith({
      name: "write_file",
      arguments: { path: "hello.txt", content: "hola" },
    });
    expect(closeMock).toHaveBeenCalledTimes(1);

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.map((e) => e.event)).toEqual(["agent_start", "tool_call", "tool_result", "agent_end"]);
    expect(events.at(-1)?.output).toBe("Listo, creé hello.txt.");
  });

  it("responde de una sin pedir ninguna tool si el primer turno ya es la respuesta final", async () => {
    createMock.mockResolvedValueOnce(textResponse("No hace falta tocar archivos."));

    const summary = await runDevAgent({ featureId, task: "solo responde", workspaceRoot: `workspaces/${featureId}` });

    expect(summary).toBe("No hace falta tocar archivos.");
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it("un error de la tool se loguea como isError y el agente sigue corriendo", async () => {
    createMock
      .mockResolvedValueOnce(toolUseResponse("toolu_1", "write_file", { path: "../fuera.txt", content: "x" }))
      .mockResolvedValueOnce(textResponse("Corregido, usé una ruta válida."));
    callToolMock.mockRejectedValueOnce(new Error("Ruta fuera del workspace permitido"));

    const summary = await runDevAgent({
      featureId,
      task: "intenta algo inválido",
      workspaceRoot: `workspaces/${featureId}`,
    });

    expect(summary).toBe("Corregido, usé una ruta válida.");

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    const toolResult = events.find((e) => e.event === "tool_result");
    expect(toolResult?.isError).toBe(true);
    expect(String(toolResult?.output)).toMatch(/fuera del workspace/);
  });

  it("respeta el tope de turnos (MAX_TURNS=12) y no se cuelga si el modelo siempre pide tools", async () => {
    createMock.mockResolvedValue(toolUseResponse("toolu_x", "write_file", { path: "a.txt", content: "x" }));
    callToolMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }], isError: false });

    const summary = await runDevAgent({
      featureId,
      task: "tarea que nunca termina",
      workspaceRoot: `workspaces/${featureId}`,
    });

    expect(summary).toBe("");
    expect(createMock).toHaveBeenCalledTimes(12);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("traduce las tools listadas por el MCP a tools de Anthropic en la llamada a Messages API", async () => {
    createMock.mockResolvedValueOnce(textResponse("listo"));

    await runDevAgent({ featureId, task: "algo", workspaceRoot: `workspaces/${featureId}` });

    const callArgs = createMock.mock.calls[0][0];
    expect(callArgs.tools).toEqual([
      { name: "write_file", description: "Escribe un archivo", input_schema: { type: "object" } },
    ]);
  });

  it("pasa WORKSPACE_ROOT al subproceso del MCP filesystem-git vía env", async () => {
    createMock.mockResolvedValueOnce(textResponse("listo"));

    await runDevAgent({ featureId, task: "algo", workspaceRoot: "workspaces/feat_x" });

    expect(lastTransportOpts?.command).toBe("npx");
    expect(lastTransportOpts?.env?.WORKSPACE_ROOT).toBe("workspaces/feat_x");
  });

  it("si Anthropic falla: se loguea el error, se cierra el cliente MCP, y se re-lanza la excepción", async () => {
    createMock.mockRejectedValueOnce(new Error("500 de la API"));

    await expect(
      runDevAgent({ featureId, task: "algo", workspaceRoot: `workspaces/${featureId}` }),
    ).rejects.toThrow("500 de la API");

    expect(closeMock).toHaveBeenCalledTimes(1);

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.at(-1)?.event).toBe("error");
  });
});
