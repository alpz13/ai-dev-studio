import { describe, expect, it } from "vitest";
import { summarizeTrace } from "../trace-summary.js";
import type { TraceEvent } from "../trace-logger.js";

// Small helper so each test can build only the fields it cares about; every
// call site here matches the real shape TraceLogger.log() actually writes
// (see trace-logger.ts / director.ts / filesystem-agent.ts).
function ev(partial: Partial<TraceEvent> & Pick<TraceEvent, "traceId" | "spanId" | "agentRole" | "event" | "timestamp">): TraceEvent {
  return { parentSpanId: undefined, ...partial } as TraceEvent;
}

const FEATURE = "feat_2026-08-26_demo";
const DIRECTOR_SPAN = "agt_director_1";

describe("observability/trace-summary: summarizeTrace", () => {
  it("an empty trace summarizes to nulls/zeros and an 'unknown' outcome", () => {
    const summary = summarizeTrace(FEATURE, []);

    expect(summary.featureId).toBe(FEATURE);
    expect(summary.totalDurationMs).toBeNull();
    expect(summary.totalTokensUsed).toBe(0);
    expect(summary.qaRetries).toBe(0);
    expect(summary.resumeEvents).toEqual([]);
    expect(summary.outcome).toBe("unknown");
    expect(summary.stages).toHaveLength(5);
    expect(summary.stages.every((s) => s.runs === 0 && s.durationMs === 0 && s.tokensUsed === 0 && !s.incomplete)).toBe(
      true,
    );
  });

  it("a clean full pipeline: correct per-stage duration/tokens, total duration, and outcome 'done'", () => {
    const events: TraceEvent[] = [
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_start", timestamp: "2026-08-26T10:00:00.000Z" }),

      ev({ traceId: FEATURE, spanId: "agt_pm_1", agentRole: "PM", event: "agent_start", timestamp: "2026-08-26T10:00:01.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_pm_1", agentRole: "PM", event: "agent_end", timestamp: "2026-08-26T10:00:11.000Z", tokensUsed: 100 }),

      ev({ traceId: FEATURE, spanId: "agt_architect_1", agentRole: "Architect", event: "agent_start", timestamp: "2026-08-26T10:00:12.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_architect_1", agentRole: "Architect", event: "agent_end", timestamp: "2026-08-26T10:00:20.000Z", tokensUsed: 150 }),

      ev({ traceId: FEATURE, spanId: "agt_dev_1", agentRole: "Dev", event: "agent_start", timestamp: "2026-08-26T10:00:21.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_dev_1", agentRole: "Dev", event: "agent_end", timestamp: "2026-08-26T10:00:41.000Z", tokensUsed: 400 }),

      ev({ traceId: FEATURE, spanId: "agt_qa_1", agentRole: "QA", event: "agent_start", timestamp: "2026-08-26T10:00:42.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_qa_1", agentRole: "QA", event: "agent_end", timestamp: "2026-08-26T10:00:52.000Z", tokensUsed: 200 }),

      ev({ traceId: FEATURE, spanId: "agt_devops_1", agentRole: "DevOps", event: "agent_start", timestamp: "2026-08-26T10:00:53.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_devops_1", agentRole: "DevOps", event: "agent_end", timestamp: "2026-08-26T10:00:58.000Z", tokensUsed: 80 }),

      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_end", timestamp: "2026-08-26T10:00:59.000Z", output: "Pipeline complete." }),
    ];

    const summary = summarizeTrace(FEATURE, events);

    expect(summary.outcome).toBe("done");
    expect(summary.totalDurationMs).toBe(59_000);
    expect(summary.totalTokensUsed).toBe(100 + 150 + 400 + 200 + 80);
    expect(summary.qaRetries).toBe(0);
    expect(summary.resumeEvents).toEqual([]);

    const byStage = Object.fromEntries(summary.stages.map((s) => [s.stage, s]));
    expect(byStage.PM).toMatchObject({ runs: 1, durationMs: 10_000, tokensUsed: 100, incomplete: false });
    expect(byStage.Architect).toMatchObject({ runs: 1, durationMs: 8_000, tokensUsed: 150, incomplete: false });
    expect(byStage.Dev).toMatchObject({ runs: 1, durationMs: 20_000, tokensUsed: 400, incomplete: false });
    expect(byStage.QA).toMatchObject({ runs: 1, durationMs: 10_000, tokensUsed: 200, incomplete: false });
    expect(byStage.DevOps).toMatchObject({ runs: 1, durationMs: 5_000, tokensUsed: 80, incomplete: false });
  });

  it("a QA retry: Dev and QA both show 2 runs, qaRetries is 1, durations/tokens sum across both runs", () => {
    const events: TraceEvent[] = [
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_start", timestamp: "2026-08-26T10:00:00.000Z" }),

      ev({ traceId: FEATURE, spanId: "agt_dev_1", agentRole: "Dev", event: "agent_start", timestamp: "2026-08-26T10:00:01.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_dev_1", agentRole: "Dev", event: "agent_end", timestamp: "2026-08-26T10:00:11.000Z", tokensUsed: 300 }),

      ev({ traceId: FEATURE, spanId: "agt_qa_1", agentRole: "QA", event: "agent_start", timestamp: "2026-08-26T10:00:12.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_qa_1", agentRole: "QA", event: "agent_end", timestamp: "2026-08-26T10:00:20.000Z", tokensUsed: 150 }),

      ev({
        traceId: FEATURE,
        spanId: DIRECTOR_SPAN,
        agentRole: "Director",
        event: "message",
        timestamp: "2026-08-26T10:00:21.000Z",
        stage: "QA",
        note: "not approved, retry 1/2",
      }),

      ev({ traceId: FEATURE, spanId: "agt_dev_2", agentRole: "Dev", event: "agent_start", timestamp: "2026-08-26T10:00:22.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_dev_2", agentRole: "Dev", event: "agent_end", timestamp: "2026-08-26T10:00:30.000Z", tokensUsed: 120 }),

      ev({ traceId: FEATURE, spanId: "agt_qa_2", agentRole: "QA", event: "agent_start", timestamp: "2026-08-26T10:00:31.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_qa_2", agentRole: "QA", event: "agent_end", timestamp: "2026-08-26T10:00:37.000Z", tokensUsed: 90 }),

      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_end", timestamp: "2026-08-26T10:00:38.000Z", output: "Pipeline complete." }),
    ];

    const summary = summarizeTrace(FEATURE, events);

    expect(summary.qaRetries).toBe(1);
    expect(summary.outcome).toBe("done");

    const byStage = Object.fromEntries(summary.stages.map((s) => [s.stage, s]));
    expect(byStage.Dev.runs).toBe(2);
    expect(byStage.Dev.durationMs).toBe(10_000 + 8_000);
    expect(byStage.Dev.tokensUsed).toBe(300 + 120);
    expect(byStage.QA.runs).toBe(2);
    expect(byStage.QA.tokensUsed).toBe(150 + 90);
  });

  it("QA exhausting its retries: outcome is 'blocked' and qaRetries matches the number of retry messages logged", () => {
    const events: TraceEvent[] = [
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_start", timestamp: "2026-08-26T10:00:00.000Z" }),
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "message", timestamp: "2026-08-26T10:00:10.000Z", stage: "QA", note: "not approved, retry 1/2" }),
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "message", timestamp: "2026-08-26T10:00:20.000Z", stage: "QA", note: "not approved, retry 2/2" }),
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_end", timestamp: "2026-08-26T10:00:30.000Z", output: "Blocked: QA kept failing after 2 retry(ies)." }),
    ];

    const summary = summarizeTrace(FEATURE, events);

    expect(summary.qaRetries).toBe(2);
    expect(summary.outcome).toBe("blocked");
  });

  it("a stage that throws: an 'error' event as the Director's last event also reads as outcome 'blocked'", () => {
    const events: TraceEvent[] = [
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_start", timestamp: "2026-08-26T10:00:00.000Z" }),
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "error", timestamp: "2026-08-26T10:00:05.000Z", stage: "Architect", output: "boom: couldn't write design.md" }),
    ];

    const summary = summarizeTrace(FEATURE, events);

    expect(summary.outcome).toBe("blocked");
  });

  it("an interrupted run: no Director terminal event yields outcome 'in_progress', null total duration, and the in-flight stage marked incomplete", () => {
    const events: TraceEvent[] = [
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_start", timestamp: "2026-08-26T10:00:00.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_pm_1", agentRole: "PM", event: "agent_start", timestamp: "2026-08-26T10:00:01.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_pm_1", agentRole: "PM", event: "agent_end", timestamp: "2026-08-26T10:00:11.000Z", tokensUsed: 100 }),
      ev({ traceId: FEATURE, spanId: "agt_architect_1", agentRole: "Architect", event: "agent_start", timestamp: "2026-08-26T10:00:12.000Z" }),
      // process dies here — no agent_end/error for Architect, and no Director terminal event either.
    ];

    const summary = summarizeTrace(FEATURE, events);

    expect(summary.outcome).toBe("in_progress");
    expect(summary.totalDurationMs).toBeNull();

    const byStage = Object.fromEntries(summary.stages.map((s) => [s.stage, s]));
    expect(byStage.PM.incomplete).toBe(false);
    expect(byStage.Architect.incomplete).toBe(true);
    expect(byStage.Architect.runs).toBe(1);
    expect(byStage.Architect.durationMs).toBe(0);
  });

  it("subagent runs: their tokens count toward the stage total, but their time is NOT double-counted into the stage duration", () => {
    const events: TraceEvent[] = [
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_start", timestamp: "2026-08-26T10:00:00.000Z" }),

      ev({ traceId: FEATURE, spanId: "agt_dev_1", agentRole: "Dev", event: "agent_start", timestamp: "2026-08-26T10:00:01.000Z" }),
      // Two subagents run *inside* Dev's own 30s span (sequentially, since
      // the parent awaits the delegate_to_subagent tool call in its loop).
      ev({ traceId: FEATURE, spanId: "agt_dev_sub_1", parentSpanId: "agt_dev_1", agentRole: "Dev", event: "agent_start", timestamp: "2026-08-26T10:00:05.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_dev_sub_1", parentSpanId: "agt_dev_1", agentRole: "Dev", event: "agent_end", timestamp: "2026-08-26T10:00:15.000Z", tokensUsed: 200 }),
      ev({ traceId: FEATURE, spanId: "agt_dev_sub_2", parentSpanId: "agt_dev_1", agentRole: "Dev", event: "agent_start", timestamp: "2026-08-26T10:00:15.000Z" }),
      ev({ traceId: FEATURE, spanId: "agt_dev_sub_2", parentSpanId: "agt_dev_1", agentRole: "Dev", event: "agent_end", timestamp: "2026-08-26T10:00:25.000Z", tokensUsed: 180 }),
      ev({ traceId: FEATURE, spanId: "agt_dev_1", agentRole: "Dev", event: "agent_end", timestamp: "2026-08-26T10:00:31.000Z", tokensUsed: 50 }),
    ];

    const summary = summarizeTrace(FEATURE, events);

    const dev = summary.stages.find((s) => s.stage === "Dev")!;
    expect(dev.runs).toBe(1); // only the top-level run counts as a "run"
    expect(dev.durationMs).toBe(30_000); // the parent's own span only, not the subagents' on top of it
    expect(dev.tokensUsed).toBe(50 + 200 + 180); // parent's own usage plus both subagents'
  });

  it("resume events are surfaced with their kind, and don't affect qaRetries", () => {
    const events: TraceEvent[] = [
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_start", timestamp: "2026-08-26T10:00:00.000Z" }),
      ev({
        traceId: FEATURE,
        spanId: DIRECTOR_SPAN,
        agentRole: "Director",
        event: "message",
        timestamp: "2026-08-26T10:00:00.500Z",
        stage: "Dev",
        note: 'Resuming feature "feat_x": it was interrupted mid-stage "Dev" — continuing from there instead of restarting.',
        resumeKind: "interrupted",
        qaRetries: 1,
      }),
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_end", timestamp: "2026-08-26T10:00:20.000Z", output: "Pipeline complete." }),
    ];

    const summary = summarizeTrace(FEATURE, events);

    expect(summary.resumeEvents).toHaveLength(1);
    expect(summary.resumeEvents[0].kind).toBe("interrupted");
    expect(summary.resumeEvents[0].stage).toBe("Dev");
    expect(summary.qaRetries).toBe(0);
  });

  it("sorts out-of-order input events by timestamp before computing anything", () => {
    const inOrder: TraceEvent[] = [
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_start", timestamp: "2026-08-26T10:00:00.000Z" }),
      ev({ traceId: FEATURE, spanId: DIRECTOR_SPAN, agentRole: "Director", event: "agent_end", timestamp: "2026-08-26T10:00:10.000Z", output: "Pipeline complete." }),
    ];
    const shuffled = [inOrder[1], inOrder[0]];

    const summary = summarizeTrace(FEATURE, shuffled);

    expect(summary.totalDurationMs).toBe(10_000);
    expect(summary.outcome).toBe("done");
  });
});
