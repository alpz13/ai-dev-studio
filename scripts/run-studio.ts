/**
 * Director CLI — Phase 3: instead of invoking each agent by hand, you talk
 * to the Director and it runs the whole pipeline (or resumes it).
 *
 * Usage:
 *   npm run studio -- "I want to export reports to CSV"
 *   npm run studio -- --resume feat_2026-08-24_export-reports-to-csv
 */
import { runDirector, MAX_QA_RETRIES } from "../src/agents/director/director.js";
import { connectFeatureStateClient, getFeatureState, type FeatureStateToolsClient } from "../src/agents/shared/feature-state-client.js";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set your API key.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let featureId: string | undefined;
  let task: string | undefined;

  if (args[0] === "--resume") {
    featureId = args[1];
    if (!featureId) {
      console.error("Usage: npm run studio -- --resume <featureId>");
      process.exit(1);
    }
  } else {
    task = args.join(" ").trim();
    if (!task) {
      console.error('Usage: npm run studio -- "description of the feature you want"');
      process.exit(1);
    }
  }

  console.log(featureId ? `== Resuming feature: ${featureId} ==` : `== New feature: "${task}" ==`);

  // Phase 6 — robust resume: before handing off to the Director, tell the
  // person up front what kind of resume this is, rather than letting it
  // look like a silent replay. "in_progress" means the previous run was
  // interrupted (crash/kill/restart) mid-stage with nothing marking it
  // failed; "blocked" means it stopped on purpose (an agent errored, or QA
  // exhausted its retries) and is presumably being resumed after a fix.
  if (featureId) {
    const stateClient = await connectFeatureStateClient("run-studio-cli-precheck");
    try {
      const existing = await getFeatureState(stateClient as unknown as FeatureStateToolsClient, featureId);
      if (existing && existing.status === "in_progress") {
        console.log(
          `   (was interrupted mid-stage "${existing.currentStage}" — resuming from there, not restarting)`,
        );
      } else if (existing && existing.status === "blocked") {
        console.log(`   (was blocked at stage "${existing.currentStage}" — resuming from there)`);
      }
    } finally {
      await stateClient.close();
    }
  }

  const { featureId: resolvedId, finalState } = await runDirector({ featureId, task });

  console.log(`\n== Result (${resolvedId}) ==`);
  console.log(`status: ${finalState.status}`);
  console.log(`currentStage: ${finalState.currentStage}`);
  console.log(`qaRetries: ${finalState.qaRetries ?? 0}/${MAX_QA_RETRIES}`);
  console.log(JSON.stringify(finalState.stages, null, 2));
  console.log(`\nWorkspace: ./workspaces/${resolvedId}`);
  console.log(`Full trace: ./logs/${resolvedId}.jsonl`);
  console.log(`Persisted state: ./features/${resolvedId}/state.json`);

  if (finalState.status === "blocked") {
    console.log(`\nIt got blocked at stage ${finalState.currentStage}. To retry after fixing it by hand:`);
    console.log(`  npm run studio -- --resume ${resolvedId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
