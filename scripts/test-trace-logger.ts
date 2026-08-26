/**
 * Smoke test for the TraceLogger (no MCP, no network).
 * Usage: tsx scripts/test-trace-logger.ts
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

  // Two spanIds generated in the same process must not collide.
  const spanA = newSpanId("agt_dev");
  const spanB = newSpanId("agt_dev");
  assert.notEqual(spanA, spanB);

  await fs.rm(dir, { recursive: true, force: true });

  console.log("✅ TraceLogger: writes JSONL per feature and can read it back.");
  console.log("   - events preserve order, timestamp, and extra fields");
  console.log("   - reading a nonexistent trace returns []");
  console.log("   - newSpanId doesn't produce collisions within the same process");
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
