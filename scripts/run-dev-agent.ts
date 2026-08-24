/**
 * CLI para correr el agente Dev solo (sin Director, Fase 2 del roadmap).
 *
 * Uso:
 *   npm run agent:dev
 *   npm run agent:dev -- feat_mi-feature "Crea un archivo README.md que explique este workspace"
 */
import { runDevAgent } from "../src/agents/dev/agent.js";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Falta ANTHROPIC_API_KEY. Copia .env.example a .env y pon tu API key.");
    process.exit(1);
  }

  const featureId = process.argv[2] ?? "feat_demo_hello-dev-agent";
  const task =
    process.argv[3] ??
    "Crea un archivo hello.txt con el texto 'Hola desde el Dev agent' y confírmalo con un commit de git.";
  const workspaceRoot = `workspaces/${featureId}`;

  console.log(`== Dev agent — feature: ${featureId} ==`);
  console.log(`Tarea: ${task}`);
  console.log(`Workspace: ${workspaceRoot}\n`);

  const summary = await runDevAgent({ featureId, task, workspaceRoot });

  console.log("\n== Resumen del agente ==");
  console.log(summary);
  console.log(`\nRevisa el workspace en ./${workspaceRoot} y la traza en ./logs/${featureId}.jsonl`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
