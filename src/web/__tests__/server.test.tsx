import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The web layer is a thin transport on top of runDirector() (Phase 3) and
// the Feature State MCP client (Phase 1/3) — both already have their own
// real-logic tests elsewhere, so here they're mocked the same way
// agents/director/__tests__/director.test.tsx mocks the 5 role agents:
// control what they "say", assert on how the HTTP layer wires them up.
const runDirectorMock = vi.fn(async (opts: { featureId: string; task?: string }) => ({
  featureId: opts.featureId,
  finalState: { featureId: opts.featureId, title: opts.task ?? opts.featureId, status: "done", currentStage: "DevOps", stages: {}, updatedAt: new Date().toISOString() },
}));

vi.mock("../../agents/director/director.js", () => ({ runDirector: runDirectorMock }));

const closeMock = vi.fn(async () => {});
const listPendingFeaturesMock = vi.fn(async () => [] as unknown[]);
const connectFeatureStateClientMock = vi.fn(async () => ({ close: closeMock }));
const getFeatureStateMock = vi.fn(async () => null as unknown);
const updateFeatureStateMock = vi.fn(async (_client: unknown, input: unknown) => input);

vi.mock("../../agents/shared/feature-state-client.js", () => ({
  connectFeatureStateClient: connectFeatureStateClientMock,
  listPendingFeatures: listPendingFeaturesMock,
  getFeatureState: getFeatureStateMock,
  updateFeatureState: updateFeatureStateMock,
}));

const { createWebServer } = await import("../server.js");
const { TraceLogger } = await import("../../observability/trace-logger.js");

const AUTH_TOKEN = "test-token";

function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${AUTH_TOKEN}` } });
}

async function readSseEvents(response: Response, count: number, signal: AbortSignal): Promise<any[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: any[] = [];
  while (events.length < count && !signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice("data: ".length)));
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

describe("web/server", () => {
  let logsDir: string;
  let featuresDir: string;
  let server: ReturnType<typeof createWebServer>;
  let baseUrl: string;

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-web-test-"));
    process.env.LOGS_DIR = logsDir;
    featuresDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-features-test-"));
    process.env.FEATURES_DIR = featuresDir;
    process.env.AUTH_TOKEN = AUTH_TOKEN;

    runDirectorMock.mockClear();
    connectFeatureStateClientMock.mockClear();
    listPendingFeaturesMock.mockClear();
    getFeatureStateMock.mockClear();
    updateFeatureStateMock.mockClear();
    closeMock.mockClear();

    server = createWebServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(logsDir, { recursive: true, force: true });
    await fs.rm(featuresDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
    delete process.env.FEATURES_DIR;
    delete process.env.AUTH_TOKEN;
  });

  it("createWebServer throws if AUTH_TOKEN is not set", () => {
    delete process.env.AUTH_TOKEN;
    expect(() => createWebServer()).toThrow(/AUTH_TOKEN/);
  });

  it("a request without a token is rejected with 401", async () => {
    const res = await fetch(`${baseUrl}/api/features`);
    expect(res.status).toBe(401);
  });

  it("a request with the wrong token is rejected with 401", async () => {
    const res = await fetch(`${baseUrl}/api/features`, { headers: { Authorization: "Bearer wrong-token" } });
    expect(res.status).toBe(401);
  });

  it("GET / serves the single-page UI", async () => {
    const res = await authedFetch(`${baseUrl}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/AI Dev Studio/);
    expect(body).toMatch(/app\.js/);
  });

  it("GET /api/features returns the pending features from the Feature State MCP client", async () => {
    listPendingFeaturesMock.mockResolvedValueOnce([
      { featureId: "feat_x", title: "X", status: "blocked", currentStage: "QA", stages: {}, updatedAt: "now" },
    ]);

    const res = await authedFetch(`${baseUrl}/api/features`);
    const body = await res.json() as { features: Array<{ featureId: string }> };

    expect(res.status).toBe(200);
    expect(body.features).toHaveLength(1);
    expect(body.features[0].featureId).toBe("feat_x");
    expect(connectFeatureStateClientMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("POST /api/features with a task generates a featureId, starts runDirector, and returns immediately", async () => {
    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "Add a CSV export endpoint" }),
    });
    const body = await res.json() as { featureId: string };

    expect(res.status).toBe(202);
    expect(body.featureId).toMatch(/^feat_\d{4}-\d{2}-\d{2}_add-a-csv-export-endpoint$/);
    expect(runDirectorMock).toHaveBeenCalledTimes(1);
    expect(runDirectorMock.mock.calls[0][0]).toEqual({ featureId: body.featureId, task: "Add a CSV export endpoint" });
  });

  it("POST /api/features with a featureId resumes it without generating a new one", async () => {
    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "feat_2026-08-24_resume-me" }),
    });
    const body = await res.json() as { featureId: string };

    expect(res.status).toBe(202);
    expect(body.featureId).toBe("feat_2026-08-24_resume-me");
    expect(runDirectorMock).toHaveBeenCalledWith({ featureId: "feat_2026-08-24_resume-me", task: undefined });
  });

  it("POST /api/features with neither task nor featureId rejects with 400 and never calls runDirector", async () => {
    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(runDirectorMock).not.toHaveBeenCalled();
  });

  it("GET /api/features/:id/stream replays existing history and then streams live events", async () => {
    const featureId = "feat_2026-08-24_stream-test";
    const logger = new TraceLogger(logsDir);
    await logger.log({ traceId: featureId, spanId: "agt_director_1", agentRole: "Director", event: "agent_start" });

    const controller = new AbortController();
    const res = await authedFetch(`${baseUrl}/api/features/${featureId}/stream`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    // First event comes from history (written before we ever connected).
    const [historical] = await readSseEvents(res, 1, controller.signal);
    expect(historical.event).toBe("agent_start");
    expect(historical.agentRole).toBe("Director");

    // A second logger.log() call for the same featureId, made after the
    // stream is open, must arrive over the live traceEvents channel.
    await logger.log({ traceId: featureId, spanId: "agt_pm_1", agentRole: "PM", event: "agent_end", output: "specs ready" });

    const res2 = await authedFetch(`${baseUrl}/api/features/${featureId}/stream`, { signal: controller.signal });
    const both = await readSseEvents(res2, 2, controller.signal);
    expect(both.map((e) => e.event)).toEqual(["agent_start", "agent_end"]);

    controller.abort();
  });

  it("GET /api/features/:id/stream accepts the token as a ?token= query param, for EventSource clients", async () => {
    const featureId = "feat_2026-08-25_query-token-test";
    const controller = new AbortController();

    const res = await fetch(`${baseUrl}/api/features/${featureId}/stream?token=${AUTH_TOKEN}`, { signal: controller.signal });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    controller.abort();
  });

  it("GET /api/features/:id/summary returns 404 when no trace exists for that feature", async () => {
    const res = await authedFetch(`${baseUrl}/api/features/feat_does_not_exist/summary`);

    expect(res.status).toBe(404);
  });

  it("GET /api/features/:id/summary summarizes the feature's trace (stage durations, tokens, QA retries)", async () => {
    const featureId = "feat_2026-08-26_summary-test";
    const logger = new TraceLogger(logsDir);
    await logger.log({ traceId: featureId, spanId: "agt_director_1", agentRole: "Director", event: "agent_start" });
    await logger.log({ traceId: featureId, spanId: "agt_pm_1", agentRole: "PM", event: "agent_start" });
    await logger.log({ traceId: featureId, spanId: "agt_pm_1", agentRole: "PM", event: "agent_end", tokensUsed: 120 });
    await logger.log({ traceId: featureId, spanId: "agt_director_1", agentRole: "Director", event: "agent_end", output: "Pipeline complete." });

    const res = await authedFetch(`${baseUrl}/api/features/${featureId}/summary`);
    const body = await res.json() as { featureId: string; outcome: string; totalTokensUsed: number; stages: Array<{ stage: string; tokensUsed: number }> };

    expect(res.status).toBe(200);
    expect(body.featureId).toBe(featureId);
    expect(body.outcome).toBe("done");
    expect(body.totalTokensUsed).toBe(120);
    expect(body.stages.find((s) => s.stage === "PM")?.tokensUsed).toBe(120);
  });

  it("closing the client connection unsubscribes it from traceEvents (no leak across requests)", async () => {
    const { traceEvents } = await import("../../observability/trace-logger.js");
    const featureId = "feat_2026-08-24_cleanup-test";

    const controller = new AbortController();
    const res = await authedFetch(`${baseUrl}/api/features/${featureId}/stream`, { signal: controller.signal });
    // res.flushHeaders() in the server sends headers synchronously before any await,
    // so the listener is already registered by the time fetch() resolves — no read needed.
    const reader = res.body!.getReader();

    expect(traceEvents.listenerCount(featureId)).toBeGreaterThan(0);

    controller.abort();
    await reader.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(traceEvents.listenerCount(featureId)).toBe(0);
  });

  it("POST /api/features with an invalid featureId rejects with 400", async () => {
    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "../../etc/passwd" }),
    });

    expect(res.status).toBe(400);
    expect(runDirectorMock).not.toHaveBeenCalled();
  });

  it("GET /api/features/:id/stream with an invalid featureId rejects with 400", async () => {
    const res = await authedFetch(`${baseUrl}/api/features/${encodeURIComponent("../../etc/passwd")}/stream`);
    expect(res.status).toBe(400);
  });

  it("GET /api/features/:id/summary with an invalid featureId rejects with 400", async () => {
    const res = await authedFetch(`${baseUrl}/api/features/${encodeURIComponent("../../etc/passwd")}/summary`);
    expect(res.status).toBe(400);
  });

  it("GET /healthz returns 200 without requiring a token", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json() as { status: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("POST /api/features rejects a duplicate start for a feature already running with 409", async () => {
    let resolveRun!: () => void;
    runDirectorMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRun = () => resolve({ featureId: "feat_locked", finalState: {} as any });
      }),
    );

    const first = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "feat_locked" }),
    });
    expect(first.status).toBe(202);

    const second = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "feat_locked" }),
    });
    expect(second.status).toBe(409);

    resolveRun();
  });

  it("a runDirector failure marks the feature blocked and logs a trace error event", async () => {
    runDirectorMock.mockImplementationOnce(async () => {
      throw new Error("Dev agent crashed");
    });

    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "feat_will-fail" }),
    });
    expect(res.status).toBe(202);

    // runDirector's rejection is handled asynchronously (fire-and-forget) —
    // give the microtask/timer queue a turn before asserting on its side effects.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updateFeatureStateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ featureId: "feat_will-fail", status: "blocked" }),
    );

    const logger = new TraceLogger(logsDir);
    const trace = await logger.readTrace("feat_will-fail");
    expect(trace.some((e) => e.event === "error" && e.note === "Dev agent crashed")).toBe(true);
  });

  it("a secondary failure while surfacing a runDirector failure is logged, not thrown", async () => {
    runDirectorMock.mockImplementationOnce(async () => {
      throw new Error("Dev agent crashed");
    });
    updateFeatureStateMock.mockImplementationOnce(async () => {
      throw new Error("feature-state MCP subprocess failed to spawn");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const res = await authedFetch(`${baseUrl}/api/features`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureId: "feat_double-fail" }),
      });
      expect(res.status).toBe(202);

      // Both the primary (runDirector) and secondary (updateFeatureState)
      // failures are handled asynchronously — give the microtask/timer
      // queue a turn before asserting nothing escaped as an unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandledRejections).toEqual([]);
      expect(
        consoleErrorSpy.mock.calls.some(
          (call) => typeof call[0] === "string" && call[0].includes("surfacePipelineFailure"),
        ),
      ).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      consoleErrorSpy.mockRestore();
    }
  });
});
