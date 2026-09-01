/**
 * Smoke test for the state logic (no MCP, no network).
 * Usage: tsx scripts/test-feature-state-store.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeatureStateStore } from "../../src/feature-state/store.js";

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-test-"));
  const store = new FeatureStateStore(tmpDir);

  // 1. A feature that doesn't exist returns null.
  const missing = await store.readState("feat_no_existe");
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

  // 3. Reading it back should give exactly the same thing (real persistence to disk).
  const reread = await store.readState("feat_demo_export-csv");
  assert.deepEqual(reread?.stages, created.stages);

  // 4. Shallow merge: updating only QA must not lose PM/Architect/Dev.
  const afterQaFail = await store.upsertState({
    featureId: "feat_demo_export-csv",
    currentStage: "QA",
    status: "blocked",
    stages: { QA: { status: "failed", notes: "2 tests failing" } },
  });
  assert.equal(afterQaFail.stages.PM?.status, "done", "must not lose the PM stage during the merge");
  assert.equal(afterQaFail.stages.QA?.status, "failed");
  assert.equal(afterQaFail.status, "blocked");

  // 5. Simulate a second, already-finished feature.
  await store.upsertState({
    featureId: "feat_demo_login",
    title: "Login with OAuth",
    status: "done",
    currentStage: "DevOps",
  });

  // 6. list_pending_features should return only the blocked one, not the finished one.
  const pending = await store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].featureId, "feat_demo_export-csv");

  await fs.rm(tmpDir, { recursive: true, force: true });

  console.log("✅ All FeatureStateStore checks passed.");
  console.log("   - readState of a nonexistent feature returns null");
  console.log("   - upsertState creates the state.json file on disk");
  console.log("   - the shallow merge preserves the previous stages");
  console.log("   - listPending correctly filters by status !== 'done'");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
