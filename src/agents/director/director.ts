/**
 * El Director: orquesta el pipeline PM → Arquitecto → Dev → QA → DevOps
 * para una feature, consultando y actualizando su estado en el Feature
 * State MCP (ver ARCHITECTURE.md sección 4) para poder retomarla si quedó
 * a medias.
 *
 * A propósito el Director NO es en sí mismo un agente que llama a Claude:
 * es código de orquestación determinista que delega cada paso de trabajo
 * real a un agente (PM/Arquitecto/Dev/QA/DevOps), cada uno de los cuales sí
 * corre su propio loop contra la Messages API. Es un patrón común de
 * multi-agente (un supervisor de código, no un LLM, decidiendo el ruteo) y
 * mantiene al Director fácil de probar sin mockear la API de Anthropic. La
 * experiencia de "hablarle" al Director por chat es Fase 5.
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

const STAGE_ORDER: StageName[] = ["PM", "Arquitecto", "Dev", "QA", "DevOps"];
const MAX_QA_RETRIES = 2;

export interface RunDirectorOptions {
  /** Si se da, retoma esa feature (debe existir ya). */
  featureId?: string;
  /** Requerido si featureId no existe todavía (crea la feature). */
  task?: string;
}

export interface DirectorResult {
  featureId: string;
  finalState: FeatureState;
}

interface StageOutcome {
  summary: string;
  artifact?: string;
  /** Solo relevante para el stage QA. */
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
        task: `Pedido del usuario: "${ctx.title}". Escribe specs.md con resumen, alcance y criterios de aceptación.`,
      });
      return { summary, artifact: "specs.md" };
    }

    case "Arquitecto": {
      const summary = await runArchitectAgent({
        ...base,
        task: `Lee specs.md y diseña la arquitectura técnica en design.md. Pedido original: "${ctx.title}".`,
      });
      return { summary, artifact: "design.md" };
    }

    case "Dev": {
      const task =
        ctx.qaRetries > 0
          ? "QA encontró problemas — revisa qa-report.md en el workspace, corrígelos, y confirma con un commit."
          : `Lee specs.md y design.md, implementa la feature, y confirma con un commit de git. Pedido original: "${ctx.title}".`;
      const summary = await runDevAgent({ ...base, task });
      return { summary };
    }

    case "QA": {
      const summary = await runQaAgent({
        ...base,
        task: 'Revisa el código contra specs.md y design.md. Escribe qa-report.md y termina tu respuesta con una línea exacta "VEREDICTO: APPROVED" o "VEREDICTO: FAILED".',
      });
      return { summary, artifact: "qa-report.md", approved: isQaApproved(summary) };
    }

    case "DevOps": {
      const summary = await runDevopsAgent({
        ...base,
        task: `Agrega una entrada a CHANGELOG.md resumiendo la feature "${ctx.title}" y confirma un commit final si hace falta.`,
      });
      return { summary, artifact: "CHANGELOG.md" };
    }
  }
}

export async function runDirector(opts: RunDirectorOptions): Promise<DirectorResult> {
  if (!opts.featureId && !opts.task) {
    throw new Error("runDirector necesita featureId (para retomar) o task (para crear una feature nueva).");
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
        throw new Error(`No existe la feature "${featureId}" y no se dio un task para crearla.`);
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

      await traceLogger.log({ ...directorCtx, event: "message", stage, note: "arrancando stage" });
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
              output: `Bloqueada: QA siguió fallando tras ${qaRetries} reintento(s).`,
            });
            return { featureId, finalState: state };
          }

          qaRetries++;
          state = await updateFeatureState(stateClient, {
            featureId,
            currentStage: "Dev",
            // Importante: también hay que resetear el estado de Dev a
            // "in_progress" — si no, el chequeo `stages[stage]?.status ===
            // "done"` de arriba se lo saltaría al volver a entrar al loop en
            // stageIndex = Dev, y el reintento nunca correría a Dev de nuevo.
            stages: {
              Dev: { status: "in_progress" },
              QA: { status: "failed", notes: outcome.summary },
            },
          });
          await traceLogger.log({
            ...directorCtx,
            event: "message",
            stage: "QA",
            note: `no aprobado, reintento ${qaRetries}/${MAX_QA_RETRIES}`,
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
    await traceLogger.log({ ...directorCtx, event: "agent_end", output: "Pipeline completo." });
    return { featureId, finalState: state };
  } finally {
    await stateClient.close();
  }
}

export { STAGE_ORDER, MAX_QA_RETRIES };
export type { FeatureStateToolsClient };
