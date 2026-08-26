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
 * Director easy to test without mocking the Anthropic API. The experience
 * of "talking" to the Director via chat is Phase 5.
 */
import { newSpanId, TraceLogger } from "../../observability/trace-logger.js";
import type { FeatureState, StageName } from "../../feature-state/store.js";
import {
  connectFeatureStateClient,
  getFeatureState,
  updateFeatureState,
  type FeatureStateToolsClient,
} from "../shared/feature-state-client.js";
import { runPmAgent } from "../pm/agent.js";
import { runArchitectAgent } from "../architect/agent.js";
import { runDevAgent } from "../dev/agent.js";
import { runQaAgent, isQaApproved } from "../qa/agent.js";
import { runDevopsAgent } from "../devops/agent.js";
import { generateFeatureId } from "./slugify.js";

const STAGE_ORDER: StageName[] = ["PM", "Architect", "Dev", "QA", "DevOps"];
const MAX_QA_RETRIES = 2;

export interface RunDirectorOptions {
  /** If given, resumes that feature (it must already exist). */
  featureId?: string;
  /** Required if featureId doesn't exist yet (creates the feature). */
  task?: string;
}

export interface DirectorResult {
  featureId: string;
  finalState: FeatureState;
}

interface StageOutcome {
  summary: string;
  artifact?: string;
  /** Only relevant for the QA stage. */
  approved?: boolean;
}

interface StageContext {
  featureId: string;
  workspaceRoot: string;
  title: string;
  qaRetries: number;
}

async function runStage(stage: StageName, ctx: StageContext): Promise<StageOutcome> {
  const base = { featureId: ctx.featureId, workspaceRoot: ctx.workspaceRoot };

  switch (stage) {
    case "PM": {
      const summary = await runPmAgent({
        ...base,
        task: `User request: "${ctx.title}". Write specs.md with a summary, scope, and acceptance criteria.`,
      });
      return { summary, artifact: "specs.md" };
    }

    case "Architect": {
      const summary = await runArchitectAgent({
        ...base,
        task: `Read specs.md and design the technical architecture in design.md. Original request: "${ctx.title}".`,
      });
      return { summary, artifact: "design.md" };
    }

    case "Dev": {
      const task =
        ctx.qaRetries > 0
          ? "QA found issues — review qa-report.md in the workspace, fix them, and commit."
          : `Read specs.md and design.md, implement the feature, and commit with git. Original request: "${ctx.title}".`;
      const summary = await runDevAgent({ ...base, task });
      return { summary };
    }

    case "QA": {
      const summary = await runQaAgent({
        ...base,
        task: 'Review the code against specs.md and design.md. Write qa-report.md and end your reply with an exact line "VERDICT: APPROVED" or "VERDICT: FAILED".',
      });
      return { summary, artifact: "qa-report.md", approved: isQaApproved(summary) };
    }

    case "DevOps": {
      const summary = await runDevopsAgent({
        ...base,
        task: `Add an entry to CHANGELOG.md summarizing the feature "${ctx.title}" and make a final commit if needed.`,
      });
      return { summary, artifact: "CHANGELOG.md" };
    }
  }
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

  try {
    await traceLogger.log({ ...directorCtx, event: "agent_start", input: { featureId, task: opts.task } });

    let state = await getFeatureState(stateClient, featureId);
    if (!state) {
      if (!opts.task) {
        throw new Error(`Feature "${featureId}" doesn't exist and no task was given to create it.`);
      }
      state = await updateFeatureState(stateClient, {
        featureId,
        title: opts.task,
        status: "in_progress",
        currentStage: "PM",
      });
    }

    const workspaceRoot = `workspaces/${featureId}`;
    let qaRetries = 0;
    let stageIndex = Math.max(0, STAGE_ORDER.indexOf(state.currentStage));

    while (stageIndex < STAGE_ORDER.length) {
      const stage = STAGE_ORDER[stageIndex];

      if (state.stages[stage]?.status === "done") {
        stageIndex++;
        continue;
      }

      await traceLogger.log({ ...directorCtx, event: "message", stage, note: "starting stage" });
      state = await updateFeatureState(stateClient, { featureId, currentStage: stage, status: "in_progress" });

      try {
        const outcome = await runStage(stage, { featureId, workspaceRoot, title: state.title, qaRetries });

        if (stage === "QA" && !outcome.approved) {
          if (qaRetries >= MAX_QA_RETRIES) {
            state = await updateFeatureState(stateClient, {
              featureId,
              status: "blocked",
              stages: { QA: { status: "failed", notes: outcome.summary } },
            });
            await traceLogger.log({
              ...directorCtx,
              event: "agent_end",
              output: `Blocked: QA kept failing after ${qaRetries} retry(ies).`,
            });
            return { featureId, finalState: state };
          }

          qaRetries++;
          state = await updateFeatureState(stateClient, {
            featureId,
            currentStage: "Dev",
            // Important: Dev's status also needs to be reset to
            // "in_progress" — otherwise the `stages[stage]?.status ===
            // "done"` check above would skip it when the loop re-enters at
            // stageIndex = Dev, and the retry would never run Dev again.
            stages: {
              Dev: { status: "in_progress" },
              QA: { status: "failed", notes: outcome.summary },
            },
          });
          await traceLogger.log({
            ...directorCtx,
            event: "message",
            stage: "QA",
            note: `not approved, retry ${qaRetries}/${MAX_QA_RETRIES}`,
          });
          stageIndex = STAGE_ORDER.indexOf("Dev");
          continue;
        }

        state = await updateFeatureState(stateClient, {
          featureId,
          stages: { [stage]: { status: "done", artifact: outcome.artifact, notes: outcome.summary } },
        });
        stageIndex++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state = await updateFeatureState(stateClient, {
          featureId,
          status: "blocked",
          stages: { [stage]: { status: "failed", notes: message } },
        });
        await traceLogger.log({ ...directorCtx, event: "error", stage, output: message });
        return { featureId, finalState: state };
      }
    }

    state = await updateFeatureState(stateClient, { featureId, status: "done" });
    await traceLogger.log({ ...directorCtx, event: "agent_end", output: "Pipeline complete." });
    return { featureId, finalState: state };
  } finally {
    await stateClient.close();
  }
}

export { STAGE_ORDER, MAX_QA_RETRIES };
export type { FeatureStateToolsClient };
