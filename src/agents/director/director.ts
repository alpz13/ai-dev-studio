/**
 * The Director: orchestrates the PM → Architect → Dev → QA → DevOps
 * pipeline for a feature, reading and updating its state in the Feature
 * State MCP (see ARCHITECTURE.md section 4) so it can be resumed if it
 * was left half-done.
 *
 * The Director is deliberately NOT itself an agent that calls Claude: it's
 * deterministic orchestration code that delegates each real work step to
 * an agent (PM/Architect/Dev/QA/DevOps), each of which does run its own
 * loop against the Messages API. This is a common multi-agent pattern (a
 * code supervisor, not an LLM, deciding the routing) and keeps the
 * Director easy to test without mocking the Anthropic API.
 *
 * Stage logic lives in stages/*.ts. Retry/resume/error mechanics live in
 * pipeline-mechanics.ts. Adding a new stage: create stages/<name>.ts and
 * add one entry to PIPELINE in pipeline.ts — nothing else changes here.
 */
import { newSpanId, TraceLogger } from "../../observability/trace-logger.js";
import {
  connectFeatureStateClient,
  getFeatureState,
  updateFeatureState,
  type FeatureStateToolsClient,
} from "../shared/feature-state-client.js";
import { generateFeatureId } from "./slugify.js";
import { PIPELINE } from "./pipeline.js";
import { resolveResumeIndex, shouldSkipStage, executeStage } from "./pipeline-mechanics.js";

export interface RunDirectorOptions {
  /** If given, resumes that feature (it must already exist). */
  featureId?: string;
  /** Required if featureId doesn't exist yet (creates the feature). */
  task?: string;
}

export interface DirectorResult {
  featureId: string;
  finalState: import("../../feature-state/store.js").FeatureState;
}

export async function runDirector(opts: RunDirectorOptions): Promise<DirectorResult> {
  if (!opts.featureId && !opts.task) {
    throw new Error("runDirector needs featureId (to resume) or task (to create a new feature).");
  }

  const traceLogger = new TraceLogger();
  const directorSpanId = newSpanId("agt_director");
  const featureId = opts.featureId ?? generateFeatureId(opts.task!);
  const directorCtx = { traceId: featureId, spanId: directorSpanId, agentRole: "Director" };

  const stateClient = await connectFeatureStateClient();
  const featureClient = stateClient as unknown as FeatureStateToolsClient;

  try {
    await traceLogger.log({ ...directorCtx, event: "agent_start", input: { featureId, task: opts.task } });

    let state = await getFeatureState(featureClient, featureId);
    const isResuming = state !== null;
    if (!state) {
      if (!opts.task) throw new Error(`Feature "${featureId}" doesn't exist and no task was given to create it.`);
      state = await updateFeatureState(featureClient, {
        featureId,
        title: opts.task,
        status: "in_progress",
        currentStage: "PM",
      });
    }

    // Phase 6 — robust resume: distinguish interrupted (crash/kill) from
    // blocked (agent threw or QA exhausted retries) so the trace is clear.
    if (isResuming && state.status !== "done") {
      const kind = state.status === "blocked" ? "blocked" : "interrupted";
      await traceLogger.log({
        ...directorCtx,
        event: "message",
        stage: state.currentStage,
        note:
          kind === "interrupted"
            ? `Resuming feature "${featureId}": it was interrupted mid-stage "${state.currentStage}" — continuing from there.`
            : `Resuming feature "${featureId}": it was blocked at stage "${state.currentStage}" — continuing from there.`,
        resumeKind: kind,
        qaRetries: state.qaRetries ?? 0,
      });
    }

    const workspaceRoot = `workspaces/${featureId}`;
    let qaRetries = state.qaRetries ?? 0;
    let stageIndex = resolveResumeIndex(state, PIPELINE);

    while (stageIndex < PIPELINE.length) {
      const stage = PIPELINE[stageIndex];

      if (shouldSkipStage(stage.name, state)) { stageIndex++; continue; }

      const ctx = { featureId, workspaceRoot, title: state.title, qaRetries };
      const result = await executeStage(stage, ctx, { featureId, featureClient, traceLogger, directorCtx });

      if (result.action === "blocked") return { featureId, finalState: result.state };

      if (result.action === "retry") {
        stageIndex = PIPELINE.findIndex((s) => s.name === result.toStageName);
        qaRetries = result.qaRetries;
        state = result.state;
        continue;
      }

      state = result.state;
      stageIndex++;
    }

    state = await updateFeatureState(featureClient, { featureId, status: "done" });
    await traceLogger.log({ ...directorCtx, event: "agent_end", output: "Pipeline complete." });
    return { featureId, finalState: state };
  } finally {
    await stateClient.close();
  }
}

// Re-export so existing consumers (run-studio.ts) keep their imports unchanged.
export { STAGE_ORDER, MAX_QA_RETRIES } from "./pipeline.js";
export type { FeatureStateToolsClient };
