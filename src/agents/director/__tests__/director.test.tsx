import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureState, UpdateFeatureStateInput } from "../../../feature-state/store.js";

// --- Mocks de los 5 agentes: el Director es orquestación determinista, así
// que probarlo no requiere simular la Messages API en absoluto — solo
// controlar qué "dice" cada agente (su string de resumen) y contar llamadas.
const runPmAgentMock = vi.fn(async () => "pm listo");
const runArchitectAgentMock = vi.fn(async () => "arquitecto listo");
const runDevAgentMock = vi.fn(async () => "dev listo");
const runQaAgentMock = vi.fn(async () => "todo bien\nVEREDICTO: APPROVED");
const runDevopsAgentMock = vi.fn(async () => "devops listo");

vi.mock("../../../agents/pm/agent.js", () => ({ runPmAgent: runPmAgentMock }));
vi.mock("../../../agents/architect/agent.js", () => ({ runArchitectAgent: runArchitectAgentMock }));
vi.mock("../../../agents/dev/agent.js", () => ({ runDevAgent: runDevAgentMock }));
vi.mock("../../../agents/qa/agent.js", () => ({
  runQaAgent: runQaAgentMock,
  isQaApproved: (text: string) => /VEREDICTO: APPROVED/i.test(text),
}));
vi.mock("../../../agents/devops/agent.js", () => ({ runDevopsAgent: runDevopsAgentMock }));

// --- Mock del Feature State MCP client: un Map en memoria que replica el
// merge superficial real de FeatureStateStore.upsertState (ver
// src/feature-state/store.ts) para que el bug de reintento de QA (Dev
// quedándose "done" y saltándose el reintento) sea detectable por estas
// pruebas exactamente como se detectaría contra el servidor MCP real.
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
    updatedAt: new Date().toISOString(),
  };
  const merged: FeatureState = {
    ...base,
    title: input.title ?? base.title,
    status: input.status ?? base.status,
    currentStage: input.currentStage ?? base.currentStage,
    stages: { ...base.stages, ...input.stages },
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

    runPmAgentMock.mockReset().mockResolvedValue("pm listo");
    runArchitectAgentMock.mockReset().mockResolvedValue("arquitecto listo");
    runDevAgentMock.mockReset().mockResolvedValue("dev listo");
    runQaAgentMock.mockReset().mockResolvedValue("todo bien\nVEREDICTO: APPROVED");
    runDevopsAgentMock.mockReset().mockResolvedValue("devops listo");

    connectFeatureStateClientMock.mockClear();
    getFeatureStateMock.mockClear();
    updateFeatureStateMock.mockClear();
    closeMock.mockClear();
  });

  afterEach(async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
  });

  it("una feature nueva corre las 5 etapas en orden y termina en 'done'", async () => {
    const result = await runDirector({ task: "Exportar reportes a CSV" });

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

  it("al retomar una feature existente, se saltan las etapas ya 'done'", async () => {
    const featureId = "feat_2026-08-24_resume-test";
    featuresDb.set(featureId, {
      featureId,
      title: "Retomar esto",
      status: "in_progress",
      currentStage: "Dev",
      stages: {
        PM: { status: "done", artifact: "specs.md", notes: "pm listo" },
        Arquitecto: { status: "done", artifact: "design.md", notes: "arquitecto listo" },
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

  it("si QA falla una vez y luego aprueba, Dev corre dos veces y termina en 'done'", async () => {
    runQaAgentMock
      .mockResolvedValueOnce("hay problemas\nVEREDICTO: FAILED")
      .mockResolvedValueOnce("ahora sí\nVEREDICTO: APPROVED");

    const result = await runDirector({ task: "Feature con un round de QA" });

    expect(runDevAgentMock).toHaveBeenCalledTimes(2);
    expect(runQaAgentMock).toHaveBeenCalledTimes(2);
    expect(runDevopsAgentMock).toHaveBeenCalledTimes(1);
    expect(result.finalState.status).toBe("done");
    expect(result.finalState.stages.Dev?.status).toBe("done");
    expect(result.finalState.stages.QA?.status).toBe("done");

    // La segunda vez que Dev corre, el task le avisa explícitamente que QA
    // encontró problemas (y no repite el prompt inicial de implementación).
    const secondDevTask = runDevAgentMock.mock.calls[1][0].task as string;
    expect(secondDevTask).toMatch(/qa-report\.md/i);
  });

  it("si QA sigue fallando más allá de MAX_QA_RETRIES, la feature queda 'blocked' y DevOps no corre", async () => {
    runQaAgentMock.mockResolvedValue("sigue fallando\nVEREDICTO: FAILED");

    const result = await runDirector({ task: "Feature que nunca pasa QA" });

    expect(result.finalState.status).toBe("blocked");
    expect(result.finalState.stages.QA?.status).toBe("failed");
    expect(runDevAgentMock).toHaveBeenCalledTimes(MAX_QA_RETRIES + 1);
    expect(runQaAgentMock).toHaveBeenCalledTimes(MAX_QA_RETRIES + 1);
    expect(runDevopsAgentMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });

  it("si una etapa lanza un error, la feature queda 'blocked' con el mensaje en notes", async () => {
    runArchitectAgentMock.mockRejectedValueOnce(new Error("boom: no se pudo escribir design.md"));

    const result = await runDirector({ task: "Feature que explota en Arquitecto" });

    expect(result.finalState.status).toBe("blocked");
    expect(result.finalState.stages.Arquitecto?.status).toBe("failed");
    expect(result.finalState.stages.Arquitecto?.notes).toMatch(/boom/);
    expect(result.finalState.stages.PM?.status).toBe("done");
    expect(runDevAgentMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });

  it("rechaza si no se da ni featureId ni task, sin llegar a conectar al feature-state MCP", async () => {
    await expect(runDirector({})).rejects.toThrow(/necesita featureId.*task/i);
    expect(connectFeatureStateClientMock).not.toHaveBeenCalled();
  });

  it("un featureId inexistente sin task rechaza con un mensaje claro, y aun así cierra el client", async () => {
    await expect(runDirector({ featureId: "feat_no_existe" })).rejects.toThrow(/No existe la feature/);
    expect(closeMock).toHaveBeenCalled();
  });

  it("registra trazas del Director con agentRole 'Director' bajo el featureId como traceId", async () => {
    const result = await runDirector({ task: "Feature para revisar trazas" });

    const logger = new TraceLogger(logsDir);
    const events = await logger.readTrace(result.featureId);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.agentRole === "Director" && e.traceId === result.featureId)).toBe(true);
    expect(events.some((e) => e.event === "agent_end")).toBe(true);
  });
});
