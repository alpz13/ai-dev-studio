import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv/config", () => ({}));

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () { return { messages: { create: createMock } }; }),
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
  StdioClientTransport: vi.fn().mockImplementation(function (opts) { return { __opts: opts }; }),
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

  it("agent_start/agent_end are logged with the given agentRole, around the loop's result", async () => {
    createMock.mockResolvedValueOnce(textResponse("Done."));
    const run = createFilesystemAgent("PM", "PM system prompt");

    const summary = await run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    expect(summary).toBe("Done.");

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.map((e) => e.event)).toEqual(["agent_start", "agent_end"]);
    expect(events.every((e) => e.agentRole === "PM")).toBe(true);
    expect(events[1].output).toBe("Done.");
  });

  it("uses the given systemPrompt in the call to Anthropic", async () => {
    createMock.mockResolvedValueOnce(textResponse("ok"));
    const run = createFilesystemAgent("QA", "You are the test QA agent.");

    await run({ featureId, task: "review this", workspaceRoot: `workspaces/${featureId}` });

    expect(createMock.mock.calls[0][0].system).toBe("You are the test QA agent.");
  });

  it("closes the MCP client even if Anthropic fails, and logs the error", async () => {
    createMock.mockRejectedValueOnce(new Error("500 from the API"));
    const run = createFilesystemAgent("Dev", "system");

    await expect(run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` })).rejects.toThrow(
      "500 from the API",
    );

    expect(closeMock).toHaveBeenCalledTimes(1);
    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.at(-1)?.event).toBe("error");
  });

  // Phase 6 — robust logging: tokensUsed on agent_end comes from
  // run-agent-loop.ts's onUsage callback, summed from the real response's
  // usage.input_tokens/output_tokens. Only these two dedicated tests pass a
  // `usage` field — every other test above keeps using the plain
  // textResponse() helper (no usage at all) and is unaffected.
  it("agent_end carries tokensUsed, summed from the Anthropic response's usage field", async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 340, output_tokens: 60 },
    });
    const run = createFilesystemAgent("Dev", "system");

    await run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    const agentEnd = events.find((e) => e.event === "agent_end");
    expect(agentEnd?.tokensUsed).toBe(400);
  });

  it("agent_end still carries tokensUsed: 0 (not undefined) when the response has no usage field", async () => {
    createMock.mockResolvedValueOnce(textResponse("ok"));
    const run = createFilesystemAgent("Dev", "system");

    await run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    const agentEnd = events.find((e) => e.event === "agent_end");
    expect(agentEnd?.tokensUsed).toBe(0);
  });

  it("each agentRole generates its own spanId with a lowercase prefix", async () => {
    createMock.mockResolvedValueOnce(textResponse("ok"));
    const run = createFilesystemAgent("Architect", "system");

    await run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events[0].spanId).toMatch(/^agt_architect_/);
  });
});

// Phase 4 — SubAgents: allowSubagents gives the agent the synthetic
// delegate_to_subagent tool (see run-agent-loop.ts) built with a real
// `run()` that launches a nested subagent — same mcpClient, its own
// spanId with parentSpanId = the parent agent's.
describe("agents/shared/filesystem-agent: createFilesystemAgent with subagents (Phase 4)", () => {
  let logsDir: string;
  const featureId = "feat_test_filesystem-agent-subagents";

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-fsagent-sub-test-"));
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

  function delegateToolUseResponse(module: string, task: string) {
    return {
      content: [{ type: "tool_use", id: "toolu_1", name: "delegate_to_subagent", input: { module, task } }],
      stop_reason: "tool_use",
    };
  }

  it("without allowSubagents (default), the model never sees delegate_to_subagent — regression for PM/Architect/QA/DevOps", async () => {
    createMock.mockResolvedValueOnce(textResponse("ok"));
    const run = createFilesystemAgent("PM", "system");

    await run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    expect(createMock.mock.calls[0][0].tools).toEqual([]);
  });

  it("with allowSubagents:true, the model sees the delegate_to_subagent tool", async () => {
    createMock.mockResolvedValueOnce(textResponse("ok"));
    const run = createFilesystemAgent("Dev", "system", { allowSubagents: true });

    await run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    const tools = createMock.mock.calls[0][0].tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("delegate_to_subagent");
  });

  it("when delegating, it runs a nested subagent (parentSpanId = the parent's spanId) and its result comes back to the parent as tool_result", async () => {
    createMock
      .mockResolvedValueOnce(delegateToolUseResponse("validation.ts", "add validation"))
      .mockResolvedValueOnce(textResponse("Subagent: validation added."))
      .mockResolvedValueOnce(textResponse("Done, I delegated the validation and I'm finished now."));

    const run = createFilesystemAgent("Dev", "Dev system", { allowSubagents: true });

    const summary = await run({
      featureId,
      task: "create the endpoint and its validation",
      workspaceRoot: `workspaces/${featureId}`,
    });

    expect(summary).toBe("Done, I delegated the validation and I'm finished now.");
    expect(createMock).toHaveBeenCalledTimes(3);

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);

    const parentStart = events.find((e) => e.event === "agent_start" && !e.parentSpanId);
    const subStart = events.find((e) => e.event === "agent_start" && e.parentSpanId);
    expect(parentStart).toBeDefined();
    expect(subStart).toBeDefined();
    expect(subStart?.parentSpanId).toBe(parentStart?.spanId);
    expect(subStart?.agentRole).toBe("Dev");
    expect((subStart?.input as any)?.module).toBe("validation.ts");

    const subEnd = events.find((e) => e.event === "agent_end" && e.spanId === subStart?.spanId);
    expect(subEnd?.output).toBe("Subagent: validation added.");
    // Phase 6: the subagent's own agent_end carries its own tokensUsed,
    // tracked separately from the parent's — none of these three mocked
    // responses set `usage`, so 0 (not undefined/NaN) is the right value.
    expect(subEnd?.tokensUsed).toBe(0);

    const parentToolResult = events.find((e) => e.event === "tool_result" && e.tool === "delegate_to_subagent");
    expect(String(parentToolResult?.output)).toBe("Subagent: validation added.");
    expect(parentToolResult?.isError).toBe(false);
  });

  it("the subagent itself does not receive the delegate_to_subagent tool (a single level of nesting)", async () => {
    createMock
      .mockResolvedValueOnce(delegateToolUseResponse("x.ts", "y"))
      .mockResolvedValueOnce(textResponse("done"))
      .mockResolvedValueOnce(textResponse("parent done"));

    const run = createFilesystemAgent("Dev", "system", { allowSubagents: true });
    await run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    // The 2nd call to create() is the subagent's (the 1st and 3rd are the parent's).
    const subagentTools = createMock.mock.calls[1][0].tools;
    expect(subagentTools).toEqual([]);
  });

  it("the subagent's spanId uses the agt_<role>_sub prefix", async () => {
    createMock
      .mockResolvedValueOnce(delegateToolUseResponse("x.ts", "y"))
      .mockResolvedValueOnce(textResponse("done"))
      .mockResolvedValueOnce(textResponse("parent done"));

    const run = createFilesystemAgent("Dev", "system", { allowSubagents: true });
    await run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    const subStart = events.find((e) => e.event === "agent_start" && e.parentSpanId);
    expect(subStart?.spanId).toMatch(/^agt_dev_sub_/);
  });

  it("if the subagent fails, the parent continues (receives the error as tool_result) and the MCP client is closed only once at the end", async () => {
    createMock
      .mockResolvedValueOnce(delegateToolUseResponse("broken.ts", "something"))
      .mockRejectedValueOnce(new Error("the subagent blew up"))
      .mockResolvedValueOnce(textResponse("I'll do it myself then."));

    const run = createFilesystemAgent("Dev", "system", { allowSubagents: true });
    const summary = await run({ featureId, task: "something", workspaceRoot: `workspaces/${featureId}` });

    expect(summary).toBe("I'll do it myself then.");
    expect(closeMock).toHaveBeenCalledTimes(1);

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    const subError = events.find((e) => e.event === "error" && e.parentSpanId);
    expect(subError?.output).toBe("the subagent blew up");
    const parentToolResult = events.find((e) => e.event === "tool_result" && e.tool === "delegate_to_subagent");
    expect(parentToolResult?.isError).toBe(true);
  });
});
