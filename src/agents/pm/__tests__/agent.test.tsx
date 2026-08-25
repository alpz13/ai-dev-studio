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

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (opts: unknown) {
    return { __opts: opts };
  }),
}));

const { runPmAgent } = await import("../../../agents/pm/agent.js");
const { TraceLogger } = await import("../../../observability/trace-logger.js");

describe("agents/pm/agent: runPmAgent", () => {
  let logsDir: string;
  const featureId = "feat_test_pm-agent";

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-pm-agent-test-"));
    process.env.LOGS_DIR = logsDir;
    process.env.ANTHROPIC_API_KEY = "test-key";
    createMock.mockReset();
    createMock.mockResolvedValue({ content: [{ type: "text", text: "specs listas" }], stop_reason: "end_turn" });
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("loguea sus eventos con agentRole 'PM'", async () => {
    await runPmAgent({ featureId, task: "quiero exportar a CSV", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.every((e) => e.agentRole === "PM")).toBe(true);
  });

  it("el system prompt le pide escribir specs.md con criterios de aceptación", async () => {
    await runPmAgent({ featureId, task: "algo", workspaceRoot: `workspaces/${featureId}` });

    const system = createMock.mock.calls[0][0].system as string;
    expect(system).toMatch(/specs\.md/);
    expect(system).toMatch(/criterios de aceptación/i);
  });
});
