import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureState, UpdateFeatureStateInput } from "../../../feature-state/store.js";

// --- Mocks of the 5 agents: the Director is deterministic orchestration,
// so testing it doesn't require simulating the Messages API at all — just
// controlling what each agent "says" (its summary string) and counting calls.
const runPmAgentMock = vi.fn(async () => "pm ready");
const runArchitectAgentMock = vi.fn(async () => "architect ready");
const runDevAgentMock = vi.fn(async () => "dev ready");
const runQaAgentMock = vi.fn(async () => "all good\nVERDICT: APPROVED");
const runDevopsAgentMock = vi.fn(async () => "devops ready");

vi.mock("../../../agents/pm/agent.js", () => ({ runPmAgent: runPmAgentMock }));
vi.mock("../../../agents/architect/agent.js", () => ({ runArchitectAgent: runArchitectAgentMock }));
vi.mock("../../../agents/dev/agent.js", () => ({ runDevAgent: runDevAgentMock }));
vi.mock("../../../agents/qa/agent.js", () => ({
  runQaAgent: runQaAgentMock,
  isQaApproved: (text: string) => /VERDICT: APPROVED/i.test(text),
}));
vi.mock("../../../agents/devops/agent.js", () => ({ runDevopsAgent: runDevopsAgentMock }));

// --- Mock of the Feature State MCP client: an in-memory Map that replicates
// the real shallow merge from FeatureStateStore.upsertState (see
// src/feature-state/store.ts) so the QA retry bug (Dev staying "done" and
// the retry getting skipped) is detectable by these tests exactly as it
// would be detected against the real MCP server.
let featuresDb = new Map<string, FeatureState>();

const closeMock = vi.fn(async () => {});
const connectFeatureStateClientMock = vi.fn(async () => ({ close: closeMock }));

const getFeatureStateMock = vi.fn(async (_client: unknown, featureId: string) => featuresDb.get(featureId) ?? null);

const updateFeatureStateMock = vi.fn(async (_client: unknown, input: UpdateFeatureStateInput) => {
  const existing = featuresDb.get(input.featureId);
  const base: FeatureState = existing ?? {
    featureId: input.featureId,
    title: input.title ?? input.featureId,
    status: "pending",
    currentStage: "PM",
    stages: {},
    qaRetries: 0,
    updatedAt: new Date().toISOString(),
  };
  const merged: FeatureState = {
    ...base,
    title: input.title ?? base.title,
    status: input.status ?? base.status,
    currentStage: input.currentStage ?? base.currentStage,
    stages: { ...base.stages, ...input.stages },
    qaRetries: input.qaRetries ?? base.qaRetries ?? 0,
    updatedAt: new Date().toISOString(),
  };
  featuresDb.set(input.featureId, merged);
  return merged;
});

vi.mock("../../../agents/shared/feature-state-client.js", () => ({
  connectFeatureStateClient: connectFeatureStateClientMock,
  getFeatureState: getFeatureStateMock,
  updateFeatureState: updateFeatureStateMock,
}));

const { runDirector, STAGE_ORDER, MAX_QA_RETRIES } = await import("../../../agents/director/director.js");
const { TraceLogger } = await import("../../../observability/trace-logger.js");

describe("agents/director/director: runDirector", () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-director-test-"));
    process.env.LOGS_DIR = logsDir;
    process.env.ANTHROPIC_API_KEY = "test-key";

    featuresDb = new Map();

    runPmAgentMock.mockReset().mockResolvedValue("pm ready");
    runArchitectAgentMock.mockReset().mockResolvedValue("architect ready");
    runDevAgentMock.mockReset().mockResolvedValue("dev ready");
    runQaAgentMock.mockReset().mockResolvedValue("all good\nVERDICT: APPROVED");
    runDevopsAgentMock.mockReset().mockResolvedValue("devops ready");

    connectFeatureStateClientMock.mockClear();
    getFeatureStateMock.mockClear();
    updateFeatureStateMock.mockClear();
    closeMock.mockClear();
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("a new feature runs the 5 stages in order and ends in 'done'", async () => {
    const result = await runDirector({ task: "Export reports to CSV" });

    expect(result.finalState.status).toBe("done");
    for (const stage of STAGE_ORDER) {
      expect(result.finalState.stages[stage]?.status).toBe("done");
    }
    expect(runPmAgentMock).toHaveBeenCalledTimes(1);
    expect(runArchitectAgentMock).toHaveBeenCalledTimes(1);
    expect(runDevAgentMock).toHaveBeenCalledTimes(1);
    expect(runQaAgentMock).toHaveBeenCalledTimes(1);
    expect(runDevopsAgentMock).toHaveBeenCalledTimes(1);
  });

  it("when resuming an existing feature, stages already 'done' are skipped", async () => {
    const featureId = "feat_2026-08-24_resume-test";
    featuresDb.set(featureId, {
      featureId,
      title: "Resume this",
      status: "in_progress",
      currentStage: "Dev",
      stages: {
        PM: { status: "done", artifact: "specs.md", notes: "pm ready" },
        Architect: { status: "done", artifact: "design.md", notes: "architect ready" },
      },
      updatedAt: new Date().toISOString(),
    });

    const result = await runDirector({ featureId });

    expect(runPmAgentMock).not.toHaveBeenCalled();
    expect(runArchitectAgentMock).not.toHaveBeenCalled();
    expect(runDevAgentMock).toHaveBeenCalledTimes(1);
    expect(runQaAgentMock).toHaveBeenCalledTimes(1);
    expect(runDevopsAgentMock).toHaveBeenCalledTimes(1);
    expect(result.finalState.status).toBe("done");
  });

  it("if QA fails once and then approves, Dev runs twice and ends in 'done'", async () => {
    runQaAgentMock
      .mockResolvedValueOnce("there are issues\nVERDICT: FAILED")
      .mockResolvedValueOnce("now it's good\nVERDICT: APPROVED");

    const result = await runDirector({ task: "Feature with one QA round" });

    expect(runDevAgentMock).toHaveBeenCalledTimes(2);
    expect(runQaAgentMock).toHaveBeenCalledTimes(2);
    expect(runDevopsAgentMock).toHaveBeenCalledTimes(1);
    expect(result.finalState.status).toBe("done");
    expect(result.finalState.stages.Dev?.status).toBe("done");
    expect(result.finalState.stages.QA?.status).toBe("done");

    // The second time Dev runs, the task explicitly tells it that QA found
    // issues (and doesn't repeat the initial implementation prompt).
    const secondDevTask = (runDevAgentMock.mock.calls[1] as unknown as [{ task: string }])[0].task;
    expect(secondDevTask).toMatch(/qa-report\.md/i);
  });

  it("if QA keeps failing past MAX_QA_RETRIES, the feature ends up 'blocked' and DevOps doesn't run", async () => {
    runQaAgentMock.mockResolvedValue("still failing\nVERDICT: FAILED");

    const result = await runDirector({ task: "Feature that never passes QA" });

    expect(result.finalState.status).toBe("blocked");
    expect(result.finalState.stages.QA?.status).toBe("failed");
    expect(runDevAgentMock).toHaveBeenCalledTimes(MAX_QA_RETRIES + 1);
    expect(runQaAgentMock).toHaveBeenCalledTimes(MAX_QA_RETRIES + 1);
    expect(runDevopsAgentMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });

  it("if a stage throws an error, the feature ends up 'blocked' with the message in notes", async () => {
    runArchitectAgentMock.mockRejectedValueOnce(new Error("boom: couldn't write design.md"));

    const result = await runDirector({ task: "Feature that blows up in Architect" });

    expect(result.finalState.status).toBe("blocked");
    expect(result.finalState.stages.Architect?.status).toBe("failed");
    expect(result.finalState.stages.Architect?.notes).toMatch(/boom/);
    expect(result.finalState.stages.PM?.status).toBe("done");
    expect(runDevAgentMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });

  it("rejects if neither featureId nor task is given, without ever connecting to the feature-state MCP", async () => {
    await expect(runDirector({})).rejects.toThrow(/needs featureId.*task/i);
    expect(connectFeatureStateClientMock).not.toHaveBeenCalled();
  });

  it("a nonexistent featureId with no task rejects with a clear message, and still closes the client", async () => {
    await expect(runDirector({ featureId: "feat_does_not_exist" })).rejects.toThrow(/doesn't exist/);
    expect(closeMock).toHaveBeenCalled();
  });

  // Phase 6 — robust resume: this is the regression test for the qaRetries
  // persistence bug. Before the fix, qaRetries was only a local variable in
  // runDirector, reset to 0 on every call — so resuming a feature that was
  // interrupted mid QA-retry-cycle would send Dev the ORIGINAL "implement
  // the feature" task instead of "QA found issues, fix them", silently
  // losing the retry context.
  it("resuming a feature that was interrupted after one QA failure sends Dev the 'fix QA issues' task, not the original one", async () => {
    const featureId = "feat_2026-08-25_interrupted-retry";
    featuresDb.set(featureId, {
      featureId,
      title: "Feature interrupted mid QA-retry",
      status: "in_progress",
      currentStage: "Dev",
      stages: {
        PM: { status: "done", artifact: "specs.md", notes: "pm ready" },
        Architect: { status: "done", artifact: "design.md", notes: "architect ready" },
        Dev: { status: "in_progress" },
        QA: { status: "failed", notes: "there are issues\nVERDICT: FAILED" },
      },
      // The interrupted run had already gone through one QA failure before
      // the process died — this is the value that must survive the resume.
      qaRetries: 1,
      updatedAt: new Date().toISOString(),
    });

    await runDirector({ featureId });

    expect(runDevAgentMock).toHaveBeenCalledTimes(1);
    const devTask = (runDevAgentMock.mock.calls[0] as unknown as [{ task: string }])[0].task;
    expect(devTask).toMatch(/qa-report\.md/i);
    expect(devTask).not.toMatch(/implement the feature/i);
  });

  it("if QA fails again after a resumed retry, the feature blocks at the correct total retry count instead of resetting to 0", async () => {
    const featureId = "feat_2026-08-25_resume-exhausts-retries";
    runQaAgentMock.mockResolvedValue("still failing\nVERDICT: FAILED");
    featuresDb.set(featureId, {
      featureId,
      title: "Feature that resumes right before exhausting retries",
      status: "in_progress",
      currentStage: "Dev",
      stages: {
        PM: { status: "done", artifact: "specs.md", notes: "pm ready" },
        Architect: { status: "done", artifact: "design.md", notes: "architect ready" },
        Dev: { status: "in_progress" },
        QA: { status: "failed", notes: "there are issues\nVERDICT: FAILED" },
      },
      // Already at MAX_QA_RETRIES: one more QA failure should block
      // immediately, without resetting the count and looping again.
      qaRetries: MAX_QA_RETRIES,
      updatedAt: new Date().toISOString(),
    });

    const result = await runDirector({ featureId });

    expect(result.finalState.status).toBe("blocked");
    expect(runDevAgentMock).toHaveBeenCalledTimes(1);
    expect(runQaAgentMock).toHaveBeenCalledTimes(1);
  });

  it("resuming an interrupted feature (status 'in_progress') logs a message noting it was interrupted, distinct from a blocked resume", async () => {
    const featureId = "feat_2026-08-25_interrupted-message";
    featuresDb.set(featureId, {
      featureId,
      title: "Interrupted feature",
      status: "in_progress",
      currentStage: "Dev",
      stages: { PM: { status: "done" }, Architect: { status: "done" } },
      qaRetries: 0,
      updatedAt: new Date().toISOString(),
    });

    const result = await runDirector({ featureId });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(result.featureId);
    const resumeMsg = events.find((e) => e.resumeKind === "interrupted");
    expect(resumeMsg).toBeDefined();
    expect(resumeMsg?.note).toMatch(/interrupted/i);
  });

  it("resuming a blocked feature logs a message noting it was blocked, not interrupted", async () => {
    const featureId = "feat_2026-08-25_blocked-message";
    featuresDb.set(featureId, {
      featureId,
      title: "Blocked feature",
      status: "blocked",
      currentStage: "QA",
      stages: {
        PM: { status: "done" },
        Architect: { status: "done" },
        Dev: { status: "done" },
        QA: { status: "failed", notes: "still failing" },
      },
      qaRetries: MAX_QA_RETRIES,
      updatedAt: new Date().toISOString(),
    });
    runQaAgentMock.mockResolvedValueOnce("now it's good\nVERDICT: APPROVED");

    const result = await runDirector({ featureId });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(result.featureId);
    const resumeMsg = events.find((e) => e.resumeKind === "blocked");
    expect(resumeMsg).toBeDefined();
    expect(resumeMsg?.note).toMatch(/blocked/i);
  });

  it("a brand-new feature (not a resume) doesn't log any resumeKind message", async () => {
    const result = await runDirector({ task: "Fresh feature, never run before" });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(result.featureId);
    expect(events.some((e) => "resumeKind" in e)).toBe(false);
  });

  it("logs Director traces with agentRole 'Director' under the featureId as traceId", async () => {
    const result = await runDirector({ task: "Feature to check traces" });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(result.featureId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.agentRole === "Director" && e.traceId === result.featureId)).toBe(true);
    expect(events.some((e) => e.event === "agent_end")).toBe(true);
  });
});
