/**
 * CLI to run the Dev agent standalone (without the Director, roadmap Phase 2).
 *
 * Usage:
 *   npm run agent:dev
 *   npm run agent:dev -- feat_my-feature "Create a README.md file explaining this workspace"
 */
import { runDevAgent } from "../src/agents/dev/agent.js";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set your API key.");
    process.exit(1);
  }

  const featureId = process.argv[2] ?? "feat_demo_hello-dev-agent";
  const task =
    process.argv[3] ??
    "Create a hello.txt file with the text 'Hello from the Dev agent' and confirm it with a git commit.";
  const workspaceRoot = `workspaces/${featureId}`;

  console.log(`== Dev agent — feature: ${featureId} ==`);
  console.log(`Task: ${task}`);
  console.log(`Workspace: ${workspaceRoot}\n`);

  const summary = await runDevAgent({ featureId, task, workspaceRoot });

  console.log("\n== Agent summary ==");
  console.log(summary);
  console.log(`\nCheck the workspace at ./${workspaceRoot} and the trace at ./logs/${featureId}.jsonl`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
