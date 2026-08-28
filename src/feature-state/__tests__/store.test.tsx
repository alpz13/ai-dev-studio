import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureStateStore, resolveFeaturesDir } from "../../feature-state/store.js";

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

  it("readState of a nonexistent feature returns null", async () => {
    await expect(store.readState("feat_does_not_exist")).resolves.toBeNull();
  });

  it("upsertState creates a new feature with the given values", async () => {
    const created = await store.upsertState({
      featureId: "feat_demo_export-csv",
      title: "Export reports to CSV",
      status: "in_progress",
      currentStage: "Dev",
      stages: { PM: { status: "done", artifact: "specs.md" } },
    });

    expect(created.title).toBe("Export reports to CSV");
    expect(created.currentStage).toBe("Dev");
    expect(created.stages.PM?.status).toBe("done");
    expect(typeof created.updatedAt).toBe("string");
  });

  it("upsertState uses sensible defaults when only featureId is given", async () => {
    const created = await store.upsertState({ featureId: "feat_x" });

    expect(created.title).toBe("feat_x");
    expect(created.status).toBe("pending");
    expect(created.currentStage).toBe("PM");
    expect(created.stages).toEqual({});
  });

  it("actually persists to disk: reading after writing gives back what was written", async () => {
    const created = await store.upsertState({
      featureId: "feat_demo",
      stages: { Dev: { status: "in_progress" } },
    });

    const reread = await store.readState("feat_demo");

    expect(reread).toEqual(created);
  });

  it("the shallow merge preserves previous stages when updating only one", async () => {
    await store.upsertState({
      featureId: "feat_demo",
      stages: {
        PM: { status: "done", artifact: "specs.md" },
        Architect: { status: "done", artifact: "design.md" },
      },
    });

    const afterQaFail = await store.upsertState({
      featureId: "feat_demo",
      currentStage: "QA",
      status: "blocked",
      stages: { QA: { status: "failed", notes: "2 tests failing" } },
    });

    expect(afterQaFail.stages.PM?.status).toBe("done");
    expect(afterQaFail.stages.Architect?.status).toBe("done");
    expect(afterQaFail.stages.QA).toEqual({ status: "failed", notes: "2 tests failing" });
    expect(afterQaFail.status).toBe("blocked");
  });

  it("listFeatures ignores stray files that aren't feature folders", async () => {
    await store.upsertState({ featureId: "feat_a" });
    await fs.writeFile(path.join(root, "a-stray-file.txt"), "noise");

    const all = await store.listFeatures();

    expect(all.map((f) => f.featureId)).toEqual(["feat_a"]);
  });

  it("listPending filters out features with status 'done'", async () => {
    await store.upsertState({ featureId: "feat_active", status: "in_progress" });
    await store.upsertState({ featureId: "feat_finished", status: "done" });

    const pending = await store.listPending();

    expect(pending).toHaveLength(1);
    expect(pending[0].featureId).toBe("feat_active");
  });

  // Phase 6 — robust resume: qaRetries needs to survive a shallow merge the
  // same way title/status/currentStage already do, since the Director
  // persists it precisely so a crash-and-resume mid-QA-retry-cycle doesn't
  // silently forget how many retries had already happened.
  it("upsertState defaults qaRetries to 0 for a newly created feature", async () => {
    const created = await store.upsertState({ featureId: "feat_fresh" });

    expect(created.qaRetries).toBe(0);
  });

  it("upsertState persists a given qaRetries", async () => {
    const created = await store.upsertState({ featureId: "feat_retried", qaRetries: 2 });

    expect(created.qaRetries).toBe(2);
  });

  it("a later update that doesn't mention qaRetries preserves the previously persisted value", async () => {
    await store.upsertState({ featureId: "feat_demo", qaRetries: 1 });

    const afterUnrelatedUpdate = await store.upsertState({
      featureId: "feat_demo",
      stages: { DevOps: { status: "done" } },
    });

    expect(afterUnrelatedUpdate.qaRetries).toBe(1);
  });
});

describe("feature-state/store: resolveFeaturesDir", () => {
  it("resolves a relative path against cwd", () => {
    expect(resolveFeaturesDir("features")).toBe(path.resolve(process.cwd(), "features"));
  });

  it("keeps an absolute path as-is", () => {
    const abs = path.resolve(os.tmpdir(), "some-dir");
    expect(resolveFeaturesDir(abs)).toBe(abs);
  });
});

describe("FeatureStateStore: atomic writes", () => {
  let root: string;
  let store: FeatureStateStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-test-"));
    store = new FeatureStateStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not corrupt state.json if the final rename step fails", async () => {
    await store.upsertState({ featureId: "feat_demo", title: "Before" });

    const fsPromises = (await import("node:fs")).promises;
    const spy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("disk full"));

    await expect(store.upsertState({ featureId: "feat_demo", title: "After" })).rejects.toThrow("disk full");

    const stillThere = await store.readState("feat_demo");
    expect(stillThere?.title).toBe("Before");

    spy.mockRestore();
  });
});

describe("FeatureStateStore: locking", () => {
  let root: string;
  let store: FeatureStateStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-test-"));
    store = new FeatureStateStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("acquireLock returns true the first time and false while still held", async () => {
    const first = await store.acquireLock("feat_demo");
    const second = await store.acquireLock("feat_demo");

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("releaseLock allows acquiring the same feature again", async () => {
    await store.acquireLock("feat_demo");

    await store.releaseLock("feat_demo");
    const reacquired = await store.acquireLock("feat_demo");

    expect(reacquired).toBe(true);
  });
});
