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
      content: [{ type: "text", text: `Todo bien.\n${QA_VERDICT_APPROVED}` }],
      stop_reason: "end_turn",
    });
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("loguea sus eventos con agentRole 'QA'", async () => {
    await runQaAgent({ featureId, task: "revisa esto", workspaceRoot: `workspaces/${featureId}` });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(featureId);
    expect(events.every((e) => e.agentRole === "QA")).toBe(true);
  });

  it("el system prompt exige un veredicto explícito y prohíbe tocar el código", async () => {
    await runQaAgent({ featureId, task: "algo", workspaceRoot: `workspaces/${featureId}` });

    const system = createMock.mock.calls[0][0].system as string;
    expect(system).toMatch(/VEREDICTO: APPROVED/);
    expect(system).toMatch(/VEREDICTO: FAILED/);
    expect(system).toMatch(/no modifiques el código/i);
  });
});

describe("agents/qa/agent: isQaApproved", () => {
  it("reconoce un veredicto aprobado, aunque tenga texto alrededor", () => {
    expect(isQaApproved(`Revisé todo, se ve bien.\n${QA_VERDICT_APPROVED}`)).toBe(true);
  });

  it("no confunde un veredicto fallido con uno aprobado", () => {
    expect(isQaApproved(`Falta manejar el caso vacío.\n${QA_VERDICT_FAILED}`)).toBe(false);
  });

  it("un texto sin ningún veredicto explícito cuenta como no aprobado", () => {
    expect(isQaApproved("No terminé de revisar todavía.")).toBe(false);
  });

  it("es insensible a mayúsculas/minúsculas", () => {
    expect(isQaApproved("veredicto: approved")).toBe(true);
  });
});
