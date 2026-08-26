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

const { runQaAgent, isQaApproved, QA_VERDICT_APPROVED, QA_VERDICT_FAILED } = await import("../../../agents/qa/agent.js");
const { TraceLogger } = await import("../../../observability/trace-logger.js");

describe("agents/qa/agent: runQaAgent", () => {
  let logsDir: string;
  const featureId = "feat_test_qa-agent";

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-qa-agent-test-"));
    process.env.LOGS_DIR = logsDir;
    process.env.ANTHROPIC_API_KEY = "test-key";
    createMock.mockReset();
    createMock.mockResolvedValue({
      content: [{ type: "text", text: `All good.\n${QA_VERDICT_APPROVED}` }],
      stop_reason: "end_turn",
    });
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("logs its events with agentRole 'QA'", async () => {
    await runQaAgent({ featureId, task: "review this", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.every((e) => e.agentRole === "QA")).toBe(true);
  });

  it("the system prompt requires an explicit verdict and forbids touching the code", async () => {
    await runQaAgent({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    const system = createMock.mock.calls[0][0].system as string;
    expect(system).toMatch(/VERDICT: APPROVED/);
    expect(system).toMatch(/VERDICT: FAILED/);
    expect(system).toMatch(/do not modify/i);
  });
});

describe("agents/qa/agent: isQaApproved", () => {
  it("recognizes an approved verdict, even with surrounding text", () => {
    expect(isQaApproved(`Reviewed everything, looks good.\n${QA_VERDICT_APPROVED}`)).toBe(true);
  });

  it("doesn't confuse a failed verdict with an approved one", () => {
    expect(isQaApproved(`Needs to handle the empty case.\n${QA_VERDICT_FAILED}`)).toBe(false);
  });

  it("text with no explicit verdict counts as not approved", () => {
    expect(isQaApproved("Haven't finished reviewing yet.")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isQaApproved("verdict: approved")).toBe(true);
  });
});
