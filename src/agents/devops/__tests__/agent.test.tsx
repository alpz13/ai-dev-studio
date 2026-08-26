import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { create: createMock } }; }),
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
  StdioClientTransport: vi.fn().mockImplementation(function (opts) { return { __opts: opts }; }),
}));

const { runDevopsAgent } = await import("../../../agents/devops/agent.js");
const { TraceLogger } = await import("../../../observability/trace-logger.js");

describe("agents/devops/agent: runDevopsAgent", () => {
  let logsDir: string;
  const featureId = "feat_test_devops-agent";

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-devops-agent-test-"));
    process.env.LOGS_DIR = logsDir;
    process.env.ANTHROPIC_API_KEY = "test-key";
    createMock.mockReset();
    createMock.mockResolvedValue({ content: [{ type: "text", text: "changelog ready" }], stop_reason: "end_turn" });
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("logs its events with agentRole 'DevOps'", async () => {
    await runDevopsAgent({ featureId, task: "wrap this up", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.every((e) => e.agentRole === "DevOps")).toBe(true);
  });

  it("the system prompt asks for a CHANGELOG.md and clarifies there's no real deployment", async () => {
    await runDevopsAgent({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    const system = createMock.mock.calls[0][0].system as string;
    expect(system).toMatch(/CHANGELOG\.md/);
    expect(system).toMatch(/no real deployment step/i);
  });
});
