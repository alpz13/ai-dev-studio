/**
 * Director CLI — Phase 3: instead of invoking each agent by hand, you talk
 * to the Director and it runs the whole pipeline (or resumes it).
 *
 * Usage:
 *   npm run studio -- "I want to export reports to CSV"
 *   npm run studio -- --resume feat_2026-08-24_export-reports-to-csv
 */
import { runDirector } from "../src/agents/director/director.js";

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

  const { featureId: resolvedId, finalState } = await runDirector({ featureId, task });

  console.log(`\n== Result (${resolvedId}) ==`);
  console.log(`status: ${finalState.status}`);
  console.log(`currentStage: ${finalState.currentStage}`);
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
