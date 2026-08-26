import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSpanId, resolveLogsDir, TraceLogger } from "../../observability/trace-logger.js";

describe("observability/trace-logger: TraceLogger", () => {
  let dir: string;
  let logger: TraceLogger;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-trace-test-"));
    logger = new TraceLogger(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("log adds a timestamp and persists the event to logs/<traceId>.jsonl", async () => {
    const event = await logger.log({
      traceId: "feat_demo",
      spanId: "agt_1",
      agentRole: "Dev",
      event: "agent_start",
      input: { task: "demo" },
    });

    expect(typeof event.timestamp).toBe("string");
    expect(new Date(event.timestamp).toString()).not.toBe("Invalid Date");

    const raw = await fs.readFile(path.join(dir, "feat_demo.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("readTrace returns the events in the order they were written", async () => {
    await logger.log({ traceId: "feat_demo", spanId: "s1", agentRole: "Dev", event: "agent_start" });
    await logger.log({ traceId: "feat_demo", spanId: "s1", agentRole: "Dev", event: "tool_call", tool: "write_file" });
    await logger.log({ traceId: "feat_demo", spanId: "s1", agentRole: "Dev", event: "agent_end" });

    const events = await logger.readTrace("feat_demo");

    expect(events.map((e) => e.event)).toEqual(["agent_start", "tool_call", "agent_end"]);
    expect(events[1].tool).toBe("write_file");
  });

  it("readTrace of a traceId with no logs returns []", async () => {
    await expect(logger.readTrace("feat_no_existe")).resolves.toEqual([]);
  });

  it("different traceIds go to different files", async () => {
    await logger.log({ traceId: "feat_a", spanId: "s1", agentRole: "Dev", event: "agent_start" });
    await logger.log({ traceId: "feat_b", spanId: "s1", agentRole: "Dev", event: "agent_start" });

    await expect(logger.readTrace("feat_a")).resolves.toHaveLength(1);
    await expect(logger.readTrace("feat_b")).resolves.toHaveLength(1);
  });

  it("newSpanId generates unique ids with the given prefix", () => {
    const a = newSpanId("agt_dev");
    const b = newSpanId("agt_dev");

    expect(a).not.toBe(b);
    expect(a.startsWith("agt_dev_")).toBe(true);
  });
});

describe("observability/trace-logger: resolveLogsDir", () => {
  it("resolves a relative path against cwd", () => {
    expect(resolveLogsDir("logs")).toBe(path.resolve(process.cwd(), "logs"));
  });

  it("keeps an absolute path as-is", () => {
    const abs = path.resolve(os.tmpdir(), "algun-dir-logs");
    expect(resolveLogsDir(abs)).toBe(abs);
  });
});
