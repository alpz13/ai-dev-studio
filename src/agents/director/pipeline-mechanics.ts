import type { FeatureState, StageName } from "../../feature-state/store.js";
import { updateFeatureState, type FeatureStateToolsClient } from "../shared/feature-state-client.js";
import type { TraceLogger } from "../../observability/trace-logger.js";
import type { StageContext, StageDefinition } from "./pipeline.js";
import { MAX_QA_RETRIES } from "./pipeline.js";

export type ExecuteStageResult =
  | { action: "advance"; state: FeatureState }
  | { action: "retry"; toStageName: StageName; qaRetries: number; state: FeatureState }
  | { action: "blocked"; state: FeatureState };

export interface ExecuteStageOpts {
  featureId: string;
  featureClient: FeatureStateToolsClient;
  traceLogger: TraceLogger;
  directorCtx: { traceId: string; spanId: string; agentRole: string };
}

/**
 * Returns the index in `pipeline` where execution should start,
 * based on the feature's current stage. Clamps to 0 if not found.
 */
export function resolveResumeIndex(feature: FeatureState, pipeline: StageDefinition[]): number {
  const idx = pipeline.findIndex((s) => s.name === feature.currentStage);
  return Math.max(0, idx);
}

/**
 * Returns true if this stage is already done and should be skipped.
 * Used in the director loop to fast-forward past completed stages on resume.
 */
export function shouldSkipStage(stageName: StageName, feature: FeatureState): boolean {
  return feature.stages[stageName]?.status === "done";
}

/**
 * Executes one pipeline stage: marks it in_progress, calls stage.run(),
 * handles QA retry logic, marks it done or blocked, and returns an action
 * that tells the director loop what to do next.
 */
export async function executeStage(
  stage: StageDefinition,
  ctx: StageContext,
  opts: ExecuteStageOpts,
): Promise<ExecuteStageResult> {
  const { featureId, featureClient, traceLogger, directorCtx } = opts;

  await traceLogger.log({ ...directorCtx, event: "message", stage: stage.name, note: "starting stage" });
  let state = await updateFeatureState(featureClient, {
    featureId,
    currentStage: stage.name,
    status: "in_progress",
  });

  try {
    const outcome = await stage.run(ctx);

    if (stage.name === "QA" && !outcome.approved) {
      if (ctx.qaRetries >= MAX_QA_RETRIES) {
        state = await updateFeatureState(featureClient, {
          featureId,
          status: "blocked",
          stages: { QA: { status: "failed", notes: outcome.summary } },
        });
        await traceLogger.log({
          ...directorCtx,
          event: "agent_end",
          output: `Blocked: QA kept failing after ${ctx.qaRetries} retry(ies).`,
        });
        return { action: "blocked", state };
      }

      const newQaRetries = ctx.qaRetries + 1;
      state = await updateFeatureState(featureClient, {
        featureId,
        currentStage: "Dev",
        // Dev's status must be reset to in_progress so the loop doesn't
        // skip it due to the stages[stage]?.status === "done" check.
        stages: {
          Dev: { status: "in_progress" },
          QA: { status: "failed", notes: outcome.summary },
        },
        qaRetries: newQaRetries,
      });
      await traceLogger.log({
        ...directorCtx,
        event: "message",
        stage: "QA",
        note: `not approved, retry ${newQaRetries}/${MAX_QA_RETRIES}`,
      });
      return { action: "retry", toStageName: "Dev", qaRetries: newQaRetries, state };
    }

    state = await updateFeatureState(featureClient, {
      featureId,
      stages: { [stage.name]: { status: "done", artifact: outcome.artifact, notes: outcome.summary } },
    });
    return { action: "advance", state };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = await updateFeatureState(featureClient, {
      featureId,
      status: "blocked",
      stages: { [stage.name]: { status: "failed", notes: message } },
    });
    await traceLogger.log({ ...directorCtx, event: "error", stage: stage.name, output: message });
    return { action: "blocked", state };
  }
}
