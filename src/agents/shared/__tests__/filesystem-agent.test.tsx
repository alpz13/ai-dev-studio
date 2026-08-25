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

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (opts: unknown) {
    return { __opts: opts };
  }),
}));

const { createFilesystemAgent } = await import("../../../agents/shared/filesystem-agent.js");
const { TraceLogger } = await import("../../../observability/trace-logger.js");

function textResponse(text: string) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" };
}

describe("agents/shared/filesystem-agent: createFilesystemAgent", () => {
  let logsDir: string;
  const featureId = "feat_test_filesystem-agent";

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-fsagent-test-"));
    process.env.LOGS_DIR = logsDir;
    process.env.ANTHROPIC_API_KEY = "test-key";

    createMock.mockReset();
    listToolsMock.mockReset();
    callToolMock.mockReset();
    closeMock.mockClear();
    connectMock.mockClear();

    listToolsMock.mockResolvedValue({ tools: [] });
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("agent_start/agent_end quedan logueados con el agentRole dado, alrededor del resultado del loop", async () => {
    createMock.mockResolvedValueOnce(textResponse("Hecho."));
    const run = createFilesystemAgent("PM", "system prompt de PM");

    const summary = await run({ featureId, task: "algo", workspaceRoot: `workspaces/${featureId}` });

    expect(summary).toBe("Hecho.");

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.map((e) => e.event)).toEqual(["agent_start", "agent_end"]);
    expect(events.every((e) => e.agentRole === "PM")).toBe(true);
    expect(events[1].output).toBe("Hecho.");
  });

  it("usa el systemPrompt dado en la llamada a Anthropic", async () => {
    createMock.mockResolvedValueOnce(textResponse("ok"));
    const run = createFilesystemAgent("QA", "Eres el agente QA de prueba.");

    await run({ featureId, task: "revisa esto", workspaceRoot: `workspaces/${featureId}` });

    expect(createMock.mock.calls[0][0].system).toBe("Eres el agente QA de prueba.");
  });

  it("cierra el cliente MCP incluso si Anthropic falla, y loguea el error", async () => {
    createMock.mockRejectedValueOnce(new Error("500 de la API"));
    const run = createFilesystemAgent("Dev", "system");

    await expect(run({ featureId, task: "algo", workspaceRoot: `workspaces/${featureId}` })).rejects.toThrow(
      "500 de la API",
    );

    expect(closeMock).toHaveBeenCalledTimes(1);
    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.at(-1)?.event).toBe("error");
  });

  it("cada agentRole genera su propio spanId con el prefijo en minúsculas", async () => {
    createMock.mockResolvedValueOnce(textResponse("ok"));
    const run = createFilesystemAgent("Arquitecto", "system");

    await run({ featureId, task: "algo", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events[0].spanId).toMatch(/^agt_arquitecto_/);
  });
});
