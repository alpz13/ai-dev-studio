/**
 * Start/resume a feature build as a background job: validate the featureId,
 * acquire its lock, fire `runDirector` without awaiting it, and surface any
 * failure into feature state + the trace log. This is transport-agnostic —
 * shared by the web server (Phase 5) and the director MCP server — so both
 * get identical behavior instead of maintaining two copies of it.
 *
 * Deliberately its own module rather than living inside director.ts: it
 * calls `runDirector` as a cross-module import, which is what lets tests
 * mock `runDirector` for it. A same-module call would bypass `vi.mock`
 * (which only intercepts imports, not a module's own internal references
 * to its own exports).
 */
import { newSpanId, TraceLogger } from "../../observability/trace-logger.js";
import {
  connectFeatureStateClient,
  getFeatureState,
  updateFeatureState,
  type FeatureStateToolsClient,
} from "../shared/feature-state-client.js";
import { generateFeatureId, isValidFeatureId } from "./slugify.js";
import { runDirector } from "./director.js";
import { FeatureStateStore, type StageName, type StageInfo } from "../../feature-state/store.js";

export class FeatureAlreadyRunningError extends Error {
  constructor(public readonly featureId: string) {
    super(`Feature "${featureId}" is already running.`);
  }
}

async function surfacePipelineFailure(featureId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[director] runDirector(${featureId}) failed:`, err);

  // This runs off the end of a fire-and-forget chain (see
  // startOrResumeFeatureInBackground below) whose only remaining step is
  // lockStore.releaseLock in a .finally(). If anything below throws — e.g.
  // the feature-state MCP subprocess fails to spawn — that rejection must
  // not propagate, or it becomes an unhandled promise rejection. So: never
  // reject; catch and log any secondary failure instead of letting it surface.
  try {
    const client = await connectFeatureStateClient();
    try {
      const featureClient = client as unknown as FeatureStateToolsClient;
      const existing = await getFeatureState(featureClient, featureId);
      const currentStage: StageName = existing?.currentStage ?? "PM";
      const stages = { [currentStage]: { status: "failed", notes: message } } as Partial<
        Record<StageName, StageInfo>
      >;
      await updateFeatureState(featureClient, { featureId, status: "blocked", stages });
    } finally {
      await client.close();
    }

    const logger = new TraceLogger();
    await logger.log({
      traceId: featureId,
      spanId: newSpanId("agt_director"),
      agentRole: "Director",
      event: "error",
      note: message,
    });
  } catch (secondaryErr) {
    console.error(
      `[director] surfacePipelineFailure(${featureId}) failed while surfacing original error "${message}":`,
      secondaryErr,
    );
  }
}

export interface StartOrResumeOptions {
  /** If given, resumes that feature (it must already exist unless task is also given). */
  featureId?: string;
  /** Required if featureId doesn't exist yet (creates the feature). */
  task?: string;
}

/**
 * Validates/resolves a featureId, acquires its lock, and fires `runDirector`
 * in the background — returning as soon as the run has started rather than
 * waiting for the (potentially multi-minute, multi-agent) pipeline to finish.
 */
export async function startOrResumeFeatureInBackground(
  opts: StartOrResumeOptions,
): Promise<{ featureId: string }> {
  const { featureId, task } = opts;
  if (!featureId && !task) {
    throw new Error("Provide either featureId (to resume) or task (to start a new feature).");
  }

  const resolvedFeatureId = featureId ?? generateFeatureId(task!);
  if (!isValidFeatureId(resolvedFeatureId)) {
    throw new Error(`Invalid featureId "${resolvedFeatureId}".`);
  }

  // A duplicate start/resume request for a feature that's already running
  // races two Director runs against the same state.json. The lock is a
  // caller-level concern (rejecting a duplicate request), not a pipeline
  // concern, so it lives here rather than in runDirector.
  const lockStore = new FeatureStateStore();
  const acquired = await lockStore.acquireLock(resolvedFeatureId);
  if (!acquired) {
    throw new FeatureAlreadyRunningError(resolvedFeatureId);
  }

  // Fire and forget: a full pipeline run makes several real Messages API
  // calls and can take a while. The caller gets the featureId back right
  // away — runDirector already persists every step to Feature State + the
  // trace log itself, so a closed connection never loses work, it just
  // stops watching it.
  runDirector({ featureId: resolvedFeatureId, task })
    .catch((err) => surfacePipelineFailure(resolvedFeatureId, err))
    .finally(() => {
      lockStore.releaseLock(resolvedFeatureId).catch((err) => {
        console.error(`[director] releaseLock(${resolvedFeatureId}) failed:`, err);
      });
    });

  return { featureId: resolvedFeatureId };
}
