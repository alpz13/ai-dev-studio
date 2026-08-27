/**
 * Trace summary CLI — Phase 6: a quick per-feature readout (stage
 * durations, tokens used, QA retries, whether/how it was resumed) without
 * having to read the raw JSONL trace by hand. The web UI shows the same
 * data via GET /api/features/:id/summary (see src/web/server.ts), backed
 * by the same summarizeTrace() function.
 *
 * Usage:
 *   npm run trace-summary -- feat_2026-08-24_export-reports-to-csv
 */
import { TraceLogger } from "../src/observability/trace-logger.js";
import { summarizeTrace, type TraceSummary } from "../src/observability/trace-summary.js";

function formatMs(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printSummary(summary: TraceSummary): void {
  console.log(`== Trace summary: ${summary.featureId} ==`);
  console.log(`outcome: ${summary.outcome}`);
  console.log(`total duration: ${formatMs(summary.totalDurationMs)}`);
  console.log(`total tokens used: ${summary.totalTokensUsed}`);
  console.log(`QA retries: ${summary.qaRetries}`);

  console.log(`\nBy stage:`);
  for (const stage of summary.stages) {
    const flag = stage.incomplete ? "  (incomplete — last run never finished)" : "";
    console.log(
      `  ${stage.stage.padEnd(10)} runs=${stage.runs}  duration=${formatMs(stage.durationMs)}  tokens=${stage.tokensUsed}${flag}`,
    );
  }

  if (summary.resumeEvents.length > 0) {
    console.log(`\nResume history:`);
    for (const r of summary.resumeEvents) {
      console.log(`  [${r.timestamp}] (${r.kind}) ${r.note}`);
    }
  }
}

async function main() {
  const featureId = process.argv[2];
  if (!featureId) {
    console.error("Usage: npm run trace-summary -- <featureId>");
    process.exit(1);
  }

  const logger = new TraceLogger();
  const events = await logger.readTrace(featureId);
  if (events.length === 0) {
    console.error(`No trace found for "${featureId}" (looked in ./logs/${featureId}.jsonl).`);
    process.exit(1);
  }

  printSummary(summarizeTrace(featureId, events));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
