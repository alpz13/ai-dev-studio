import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La mecánica del loop agentic (tool calls, reintentos, max turns) ya está
// cubierta por __test__/agents/shared/run-agent-loop.test.tsx (sin mocks) y
// __test__/agents/shared/filesystem-agent.test.tsx (la factory). Esta suite
// solo confirma que runDevAgent está bien cableado: el agentRole correcto y
// un system prompt que de verdad suena a Dev.
vi.mock("dotenv/config", () => ({}));

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: createMock } };
  }),
}));

const listToolsMock = vi.fn().mockResolvedValue({ tools: [] });
const callToolMock = vi.fn();
const closeMock = vi.fn().mockResolvedValue(undefined);
const connectMock = vi.fn().mockResolvedValue(undefined);

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

let lastTransportOpts: { env?: Record<string, string> } | undefined;
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (opts: { env?: Record<string, string> }) {
    lastTransportOpts = opts;
    return { __opts: opts };
  }),
}));

const { runDevAgent } = await import("../../../agents/dev/agent.js");
const { TraceLogger } = await import("../../../observability/trace-logger.js");

describe("agents/dev/agent: runDevAgent", () => {
  let logsDir: string;
  const featureId = "feat_test_dev-agent";

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-dev-agent-test-"));
    process.env.LOGS_DIR = logsDir;
    process.env.ANTHROPIC_API_KEY = "test-key";

    createMock.mockReset();
    createMock.mockResolvedValue({ content: [{ type: "text", text: "Listo." }], stop_reason: "end_turn" });
    lastTransportOpts = undefined;
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("loguea sus eventos con agentRole 'Dev'", async () => {
    await runDevAgent({ featureId, task: "implementa algo", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.every((e) => e.agentRole === "Dev")).toBe(true);
  });

  it("el system prompt menciona confirmar los cambios con un commit de git", async () => {
    await runDevAgent({ featureId, task: "implementa algo", workspaceRoot: `workspaces/${featureId}` });

    expect(createMock.mock.calls[0][0].system).toMatch(/commit/i);
  });

  it("conecta el MCP filesystem-git apuntando al workspaceRoot dado", async () => {
    await runDevAgent({ featureId, task: "algo", workspaceRoot: "workspaces/feat_custom" });

    expect(lastTransportOpts?.env?.WORKSPACE_ROOT).toBe("workspaces/feat_custom");
  });
});
