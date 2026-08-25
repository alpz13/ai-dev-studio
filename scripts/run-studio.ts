/**
 * CLI del Director — Fase 3: en vez de invocar cada agente a mano, le
 * hablas al Director y él corre el pipeline completo (o lo retoma).
 *
 * Uso:
 *   npm run studio -- "quiero exportar reportes a CSV"
 *   npm run studio -- --resume feat_2026-08-24_exportar-reportes-a-csv
 */
import { runDirector } from "../src/agents/director/director.js";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Falta ANTHROPIC_API_KEY. Copia .env.example a .env y pon tu API key.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let featureId: string | undefined;
  let task: string | undefined;

  if (args[0] === "--resume") {
    featureId = args[1];
    if (!featureId) {
      console.error("Uso: npm run studio -- --resume <featureId>");
      process.exit(1);
    }
  } else {
    task = args.join(" ").trim();
    if (!task) {
      console.error('Uso: npm run studio -- "descripción de la feature que quieres"');
      process.exit(1);
    }
  }

  console.log(featureId ? `== Retomando feature: ${featureId} ==` : `== Nueva feature: "${task}" ==`);

  const { featureId: resolvedId, finalState } = await runDirector({ featureId, task });

  console.log(`\n== Resultado (${resolvedId}) ==`);
  console.log(`status: ${finalState.status}`);
  console.log(`currentStage: ${finalState.currentStage}`);
  console.log(JSON.stringify(finalState.stages, null, 2));
  console.log(`\nWorkspace: ./workspaces/${resolvedId}`);
  console.log(`Traza completa: ./logs/${resolvedId}.jsonl`);
  console.log(`Estado persistido: ./features/${resolvedId}/state.json`);

  if (finalState.status === "blocked") {
    console.log(`\nQuedó bloqueada en el stage ${finalState.currentStage}. Para reintentar tras corregir a mano:`);
    console.log(`  npm run studio -- --resume ${resolvedId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
