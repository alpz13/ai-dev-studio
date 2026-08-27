/**
 * Turns a feature's raw trace (the JSONL events written by TraceLogger,
 * see trace-logger.ts) into a compact summary: how long each pipeline
 * stage took, how many tokens were used, how many times QA sent the
 * feature back to Dev, and whether the run that produced this trace was a
 * resume (and of what kind). Phase 6 — robust logging and resume.
 *
 * Deliberately pure (TraceEvent[] in, TraceSummary out, no I/O): it only
 * needs whatever TraceLogger.readTrace() already returns, so it's usable
 * from both the CLI (scripts/trace-summary.ts) and the web server's
 * summary endpoint (src/web/server.ts) without either of them duplicating
 * this logic, and it's trivially unit-testable without touching the
 * filesystem.
 */
import type { TraceEvent } from "./trace-logger.js";
import type { StageName } from "../feature-state/store.js";

// Mirrors director.ts's STAGE_ORDER. Duplicated on purpose rather than
// imported: this module lives in observability, a lower-level concern
// that agents/director depends on — importing back from director.ts
// would invert that dependency for no real benefit, since the pipeline's
// stage order is effectively fixed.
const STAGE_ORDER: StageName[] = ["PM", "Architect", "Dev", "QA", "DevOps"];

export interface StageSummary {
  stage: StageName;
  /** How many top-level runs of this stage's agent appear in the trace (>1 means QA sent it back at least once). */
  runs: number;
  /** Sum of the top-level runs' durations (agent_start -> agent_end/error), in milliseconds. Excludes subagent time, since a subagent runs inside its parent's own duration. */
  durationMs: number;
  /** Sum of tokensUsed across every run of this stage, including subagents (their usage is real, additional token spend, not double-counted time). */
  tokensUsed: number;
  /** True if the most recent run of this stage has an agent_start with no matching agent_end/error — i.e. the process died mid-run. */
  incomplete: boolean;
}

export interface ResumeEvent {
  timestamp: string;
  stage: string;
  kind: "interrupted" | "blocked";
  note: string;
}

export type FeatureOutcome = "done" | "blocked" | "in_progress" | "unknown";

export interface TraceSummary {
  featureId: string;
  /** Director's own agent_start -> agent_end/error span, in milliseconds. Null if the trace has no Director agent_start (e.g. empty trace). */
  totalDurationMs: number | null;
  /** Sum of tokensUsed across every agent_end event in the trace (Director's own agent_end never carries tokensUsed, since the Director doesn't call Claude itself). */
  totalTokensUsed: number;
  /** Number of times QA sent the feature back to Dev, counted from the Director's own "not approved, retry N/M" messages — independent of feature-state, derived purely from the trace. */
  qaRetries: number;
  stages: StageSummary[];
  /** Every "resuming feature..." message the Director logged — normally 0 or 1, but a feature resumed more than once across its life will have one per resume. */
  resumeEvents: ResumeEvent[];
  /** Best-effort read of how the run captured by this trace ended, inferred from the Director's last terminal event. "in_progress" also covers "was interrupted mid-run" — the trace alone can't tell those apart from "still running right now". */
  outcome: FeatureOutcome;
}

function byTimestamp(a: TraceEvent, b: TraceEvent): number {
  return a.timestamp.localeCompare(b.timestamp);
}

function durationMs(startIso: string, endIso: string): number {
  return new Date(endIso).getTime() - new Date(startIso).getTime();
}

export function summarizeTrace(featureId: string, events: TraceEvent[]): TraceSummary {
  const sorted = [...events].sort(byTimestamp);

  const directorEvents = sorted.filter((e) => e.agentRole === "Director");
  const stageEvents = sorted.filter((e) => e.agentRole !== "Director");

  // --- Total duration: Director's own agent_start to its last agent_end/error.
  const directorStart = directorEvents.find((e) => e.event === "agent_start");
  const directorTerminal = [...directorEvents].reverse().find((e) => e.event === "agent_end" || e.event === "error");
  const totalDurationMs =
    directorStart && directorTerminal ? durationMs(directorStart.timestamp, directorTerminal.timestamp) : null;

  // --- Outcome: read the Director's last terminal event, if any.
  let outcome: FeatureOutcome = "in_progress";
  if (directorTerminal) {
    if (directorTerminal.event === "error") {
      outcome = "blocked";
    } else {
      const output = typeof directorTerminal.output === "string" ? directorTerminal.output : "";
      outcome = output.startsWith("Blocked") ? "blocked" : output.startsWith("Pipeline complete") ? "done" : "unknown";
    }
  } else if (directorEvents.length === 0) {
    outcome = "unknown";
  }

  // --- QA retries: one "message" event per retry, logged by the Director.
  const qaRetries = directorEvents.filter(
    (e) => e.event === "message" && e.stage === "QA" && typeof e.note === "string" && /retry \d+\/\d+/i.test(e.note),
  ).length;

  // --- Resume events: logged once per resumed run, tagged with resumeKind.
  const resumeEvents: ResumeEvent[] = directorEvents
    .filter((e): e is TraceEvent & { resumeKind: "interrupted" | "blocked" } =>
      e.resumeKind === "interrupted" || e.resumeKind === "blocked",
    )
    .map((e) => ({
      timestamp: e.timestamp,
      stage: typeof e.stage === "string" ? e.stage : "",
      kind: e.resumeKind,
      note: typeof e.note === "string" ? e.note : "",
    }));

  // --- Per-stage runs: group by spanId to reconstruct each individual
  // agent invocation (a stage can have several, e.g. Dev after a QA retry).
  const bySpan = new Map<string, TraceEvent[]>();
  for (const e of stageEvents) {
    const list = bySpan.get(e.spanId) ?? [];
    list.push(e);
    bySpan.set(e.spanId, list);
  }

  const stageSummaries = new Map<StageName, StageSummary>(
    STAGE_ORDER.map((stage) => [stage, { stage, runs: 0, durationMs: 0, tokensUsed: 0, incomplete: false }]),
  );

  for (const spanEvents of bySpan.values()) {
    const start = spanEvents.find((e) => e.event === "agent_start");
    if (!start) continue; // no agent_start at all — nothing we can attribute
    const stage = start.agentRole as StageName;
    const summary = stageSummaries.get(stage);
    if (!summary) continue; // defensive: unknown role, ignore rather than throw

    const terminal = spanEvents.find((e) => e.event === "agent_end" || e.event === "error");
    const isSubagent = typeof start.parentSpanId === "string";
    const tokensUsed = terminal && typeof terminal.tokensUsed === "number" ? terminal.tokensUsed : 0;

    summary.tokensUsed += tokensUsed;

    if (!isSubagent) {
      summary.runs += 1;
      if (terminal) {
        summary.durationMs += durationMs(start.timestamp, terminal.timestamp);
      } else {
        summary.incomplete = true;
      }
    }
  }

  const totalTokensUsed = [...stageSummaries.values()].reduce((sum, s) => sum + s.tokensUsed, 0);

  return {
    featureId,
    totalDurationMs,
    totalTokensUsed,
    qaRetries,
    stages: STAGE_ORDER.map((stage) => stageSummaries.get(stage)!),
    resumeEvents,
    outcome,
  };
}
