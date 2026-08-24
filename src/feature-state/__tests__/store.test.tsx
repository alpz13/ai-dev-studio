import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeatureStateStore, resolveFeaturesDir } from "../store.js";

describe("feature-state/store: FeatureStateStore", () => {
  let root: string;
  let store: FeatureStateStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-test-"));
    store = new FeatureStateStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("readState de una feature inexistente devuelve null", async () => {
    await expect(store.readState("feat_no_existe")).resolves.toBeNull();
  });

  it("upsertState crea una feature nueva con los valores dados", async () => {
    const created = await store.upsertState({
      featureId: "feat_demo_export-csv",
      title: "Exportar reportes a CSV",
      status: "in_progress",
      currentStage: "Dev",
      stages: { PM: { status: "done", artifact: "specs.md" } },
    });

    expect(created.title).toBe("Exportar reportes a CSV");
    expect(created.currentStage).toBe("Dev");
    expect(created.stages.PM?.status).toBe("done");
    expect(typeof created.updatedAt).toBe("string");
  });

  it("upsertState usa defaults razonables cuando solo se da featureId", async () => {
    const created = await store.upsertState({ featureId: "feat_x" });

    expect(created.title).toBe("feat_x");
    expect(created.status).toBe("pending");
    expect(created.currentStage).toBe("PM");
    expect(created.stages).toEqual({});
  });

  it("persiste de verdad a disco: leer después de escribir da lo mismo que se escribió", async () => {
    const created = await store.upsertState({
      featureId: "feat_demo",
      stages: { Dev: { status: "in_progress" } },
    });

    const reread = await store.readState("feat_demo");

    expect(reread).toEqual(created);
  });

  it("el merge superficial conserva los stages previos al actualizar solo uno", async () => {
    await store.upsertState({
      featureId: "feat_demo",
      stages: {
        PM: { status: "done", artifact: "specs.md" },
        Arquitecto: { status: "done", artifact: "design.md" },
      },
    });

    const afterQaFail = await store.upsertState({
      featureId: "feat_demo",
      currentStage: "QA",
      status: "blocked",
      stages: { QA: { status: "failed", notes: "2 tests failing" } },
    });

    expect(afterQaFail.stages.PM?.status).toBe("done");
    expect(afterQaFail.stages.Arquitecto?.status).toBe("done");
    expect(afterQaFail.stages.QA).toEqual({ status: "failed", notes: "2 tests failing" });
    expect(afterQaFail.status).toBe("blocked");
  });

  it("listFeatures ignora archivos sueltos que no son carpetas de feature", async () => {
    await store.upsertState({ featureId: "feat_a" });
    await fs.writeFile(path.join(root, "un-archivo-suelto.txt"), "ruido");

    const all = await store.listFeatures();

    expect(all.map((f) => f.featureId)).toEqual(["feat_a"]);
  });

  it("listPending filtra las features con status 'done'", async () => {
    await store.upsertState({ featureId: "feat_activa", status: "in_progress" });
    await store.upsertState({ featureId: "feat_terminada", status: "done" });

    const pending = await store.listPending();

    expect(pending).toHaveLength(1);
    expect(pending[0].featureId).toBe("feat_activa");
  });
});

describe("feature-state/store: resolveFeaturesDir", () => {
  it("resuelve una ruta relativa contra cwd", () => {
    expect(resolveFeaturesDir("features")).toBe(path.resolve(process.cwd(), "features"));
  });

  it("respeta una ruta absoluta tal cual", () => {
    const abs = path.resolve(os.tmpdir(), "algun-dir");
    expect(resolveFeaturesDir(abs)).toBe(abs);
  });
});
