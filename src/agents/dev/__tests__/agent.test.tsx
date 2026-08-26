import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The agentic loop mechanics (tool calls, retries, max turns) are already
// covered by __test__/agents/shared/run-agent-loop.test.tsx (no mocks) and
// __test__/agents/shared/filesystem-agent.test.tsx (the factory). This
// suite only confirms that runDevAgent is wired correctly: the right
// agentRole and a system prompt that genuinely sounds like Dev.
vi.mock("dotenv/config", () => ({}));

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { create: createMock } }; }),
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
  StdioClientTransport: vi.fn().mockImplementation(function (opts) {
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
    createMock.mockResolvedValue({ content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" });
    lastTransportOpts = undefined;
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("logs its events with agentRole 'Dev'", async () => {
    await runDevAgent({ featureId, task: "implement something", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.every((e) => e.agentRole === "Dev")).toBe(true);
  });

  it("the system prompt mentions committing changes with a git commit", async () => {
    await runDevAgent({ featureId, task: "implement something", workspaceRoot: `workspaces/${featureId}` });

    expect(createMock.mock.calls[0][0].system).toMatch(/commit/i);
  });

  it("connects the filesystem-git MCP pointing at the given workspaceRoot", async () => {
    await runDevAgent({ featureId, task: "something", workspaceRoot: "workspaces/feat_custom" });

    expect(lastTransportOpts?.env?.WORKSPACE_ROOT).toBe("workspaces/feat_custom");
  });

  // Phase 4 — SubAgents: unlike PM/Architect/QA/DevOps, Dev is created with
  // { allowSubagents: true } (see agent.ts). The wiring itself (nested
  // spanId, parentSpanId, etc.) is already tested in
  // shared/__tests__/filesystem-agent.test.tsx — here we just confirm Dev
  // actually has it turned on.

  it("exposes the delegate_to_subagent tool (allowSubagents is on for Dev)", async () => {
    await runDevAgent({ featureId, task: "implement something", workspaceRoot: `workspaces/${featureId}` });

    const tools = createMock.mock.calls[0][0].tools;
    expect(tools.some((t: any) => t.name === "delegate_to_subagent")).toBe(true);
  });

  it("the system prompt explains when to delegate to a subagent and when not to", async () => {
    await runDevAgent({ featureId, task: "implement something", workspaceRoot: `workspaces/${featureId}` });

    const system = createMock.mock.calls[0][0].system as string;
    expect(system).toMatch(/delegate_to_subagent/);
    expect(system).toMatch(/single-file/i);
  });
});
