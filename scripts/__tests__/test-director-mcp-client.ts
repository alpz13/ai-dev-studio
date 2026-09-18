/**
 * End-to-end test for the Director MCP server: spawns it as a subprocess
 * (stdio), connects as an MCP client, and exercises tool listing plus the
 * error/edge paths of all 4 tools. Deliberately never starts a real
 * pipeline run (that requires ANTHROPIC_API_KEY and costs real API calls),
 * so this stays in the no-API-key-required bucket like the other legacy
 * MCP test scripts.
 *
 * Note: `list_features`/`get_feature_state` go through `run_feature`'s
 * `connectFeatureStateClient()`, which spawns the feature-state MCP server
 * without forwarding FEATURES_DIR (a pre-existing gap in
 * src/agents/shared/feature-state-client.ts, unrelated to this server) —
 * so those two calls below only assert on shape/not-found behavior, not on
 * isolation from the real project `features/` directory.
 *
 * Usage: npm run test:mcp-director
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FeatureStateStore } from "../../src/feature-state/store.js";

function textOf(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content)[0].text;
}

async function main() {
  const featuresDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-director-mcp-test-"));

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp-servers/director/server.ts"],
    env: { ...getDefaultEnvironment(), FEATURES_DIR: featuresDir },
  });

  const client = new Client({ name: "test-director-client", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ["get_feature_state", "get_feature_status", "list_features", "run_feature"],
  );

  const missingInput = await client.callTool({ name: "run_feature", arguments: {} });
  assert.equal(missingInput.isError, true);
  assert.match(textOf(missingInput), /Provide either featureId/);

  // Acquire the lock ourselves first (same FEATURES_DIR the server sees via
  // its own env), so run_feature must surface FeatureAlreadyRunningError
  // instead of ever calling runDirector.
  const lockedFeatureId = "feat_test_locked-feature";
  const lockStore = new FeatureStateStore(featuresDir);
  const acquired = await lockStore.acquireLock(lockedFeatureId);
  assert.equal(acquired, true);
  try {
    const lockConflict = await client.callTool({ name: "run_feature", arguments: { featureId: lockedFeatureId } });
    assert.equal(lockConflict.isError, true);
    assert.match(textOf(lockConflict), /already running/);
  } finally {
    await lockStore.releaseLock(lockedFeatureId);
  }

  const missingStatus = await client.callTool({
    name: "get_feature_status",
    arguments: { featureId: "feat_does-not-exist" },
  });
  assert.equal(missingStatus.isError, undefined);
  assert.match(textOf(missingStatus), /No trace found/);

  const missingState = await client.callTool({
    name: "get_feature_state",
    arguments: { featureId: "feat_does-not-exist" },
  });
  assert.equal(missingState.isError, undefined);
  assert.match(textOf(missingState), /No state exists/);

  const pending = await client.callTool({ name: "list_features", arguments: {} });
  assert.equal(pending.isError, undefined);
  assert.ok(Array.isArray(JSON.parse(textOf(pending))));

  await client.close();
  await fs.rm(featuresDir, { recursive: true, force: true });

  console.log("✅ director-mcp: tools/list exposes run_feature, get_feature_status, get_feature_state, list_features.");
  console.log("   - run_feature validates input and surfaces lock conflicts as isError, without ever invoking runDirector");
  console.log("   - get_feature_status/get_feature_state report 'not found' instead of crashing on an unknown featureId");
  console.log("   - list_features returns without crashing");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
