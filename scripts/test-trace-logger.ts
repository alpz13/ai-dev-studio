/**
 * Prueba de humo del TraceLogger (sin MCP, sin red).
 * Uso: tsx scripts/test-trace-logger.ts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newSpanId, TraceLogger } from "../src/observability/trace-logger.js";

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-trace-test-"));
  const logger = new TraceLogger(dir);

  const traceId = "feat_test_demo";
  const spanId = newSpanId("agt_dev");

  await logger.log({ traceId, spanId, agentRole: "Dev", event: "agent_start", input: { task: "demo" } });
  await logger.log({ traceId, spanId, agentRole: "Dev", event: "tool_call", tool: "write_file", input: { path: "hello.txt" } });
  await logger.log({ traceId, spanId, agentRole: "Dev", event: "agent_end", output: "ok" });

  const events = await logger.readTrace(traceId);
  assert.equal(events.length, 3);
  assert.equal(events[0].event, "agent_start");
  assert.equal(events[2].event, "agent_end");
  assert.ok(events.every((e) => typeof e.timestamp === "string" && e.timestamp.length > 0));
  assert.ok(events.every((e) => e.agentRole === "Dev" && e.traceId === traceId));

  const emptyTrace = await logger.readTrace("feat_no_existe");
  assert.deepEqual(emptyTrace, []);

  // Dos spanId generados en el mismo proceso no deben chocar.
  const spanA = newSpanId("agt_dev");
  const spanB = newSpanId("agt_dev");
  assert.notEqual(spanA, spanB);

  await fs.rm(dir, { recursive: true, force: true });

  console.log("✅ TraceLogger: escribe JSONL por feature y lo puede releer.");
  console.log("   - los eventos conservan orden, timestamp y campos extra");
  console.log("   - leer una traza inexistente devuelve []");
  console.log("   - newSpanId no genera colisiones dentro del mismo proceso");
}

main().catch((err) => {
  console.error("❌ Falló la prueba:", err);
  process.exit(1);
});
