/**
 * Smoke test for state logic (no MCP, no network).
 * Usage: tsx scripts/test-feature-state-store.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeatureStateStore } from "../src/feature-state/store.js";

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-test-"));
  const store = new FeatureStateStore(tmpDir);

  // 1. A feature that does not exist returns null.
  const missing = await store.readState("feat_nonexistent");
  assert.equal(missing, null);

  // 2. Create a new feature via upsert.
  const created = await store.upsertState({
    featureId: "feat_demo_export-csv",
    title: "Export reports to CSV",
    status: "in_progress",
    currentStage: "Dev",
    stages: {
      PM: { status: "done", artifact: "specs.md" },
      Architect: { status: "done", artifact: "design.md" },
      Dev: { status: "in_progress" },
    },
  });
  assert.equal(created.title, "Export reports to CSV");
  assert.equal(created.currentStage, "Dev");
  assert.equal(created.stages.PM?.status, "done");

  // 3. Reading it back must return exactly the same data (real disk persistence).
  const reread = await store.readState("feat_demo_export-csv");
  assert.deepEqual(reread?.stages, created.stages);

  // 4. Shallow merge: updating only QA must not lose PM/Architect/Dev.
  const afterQaFail = await store.upsertState({
    featureId: "feat_demo_export-csv",
    currentStage: "QA",
    status: "blocked",
    stages: { QA: { status: "failed", notes: "2 tests failing" } },
  });
  assert.equal(afterQaFail.stages.PM?.status, "done", "PM stage must not be lost in the merge");
  assert.equal(afterQaFail.stages.QA?.status, "failed");
  assert.equal(afterQaFail.status, "blocked");

  // 5. Simulate a second feature that is already done.
  await store.upsertState({
    featureId: "feat_demo_login",
    title: "Login with OAuth",
    status: "done",
    currentStage: "DevOps",
  });

  // 6. listPending should return only the blocked one, not the finished one.
  const pending = await store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].featureId, "feat_demo_export-csv");

  await fs.rm(tmpDir, { recursive: true, force: true });

  console.log("✅ All FeatureStateStore checks passed.");
  console.log("   - readState for a nonexistent feature returns null");
  console.log("   - upsertState creates the state.json file on disk");
  console.log("   - shallow merge preserves previous stages");
  console.log("   - listPending correctly filters by status !== 'done'");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
