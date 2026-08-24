import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSpanId, resolveLogsDir, TraceLogger } from "../trace-logger.js";

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

  it("log agrega un timestamp y persiste el evento en logs/<traceId>.jsonl", async () => {
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

  it("readTrace devuelve los eventos en el orden en que se escribieron", async () => {
    await logger.log({ traceId: "feat_demo", spanId: "s1", agentRole: "Dev", event: "agent_start" });
    await logger.log({ traceId: "feat_demo", spanId: "s1", agentRole: "Dev", event: "tool_call", tool: "write_file" });
    await logger.log({ traceId: "feat_demo", spanId: "s1", agentRole: "Dev", event: "agent_end" });

    const events = await logger.readTrace("feat_demo");

    expect(events.map((e) => e.event)).toEqual(["agent_start", "tool_call", "agent_end"]);
    expect(events[1].tool).toBe("write_file");
  });

  it("readTrace de un traceId sin logs devuelve []", async () => {
    await expect(logger.readTrace("feat_no_existe")).resolves.toEqual([]);
  });

  it("traceId distintos van a archivos distintos", async () => {
    await logger.log({ traceId: "feat_a", spanId: "s1", agentRole: "Dev", event: "agent_start" });
    await logger.log({ traceId: "feat_b", spanId: "s1", agentRole: "Dev", event: "agent_start" });

    await expect(logger.readTrace("feat_a")).resolves.toHaveLength(1);
    await expect(logger.readTrace("feat_b")).resolves.toHaveLength(1);
  });

  it("newSpanId genera ids únicos con el prefijo dado", () => {
    const a = newSpanId("agt_dev");
    const b = newSpanId("agt_dev");

    expect(a).not.toBe(b);
    expect(a.startsWith("agt_dev_")).toBe(true);
  });
});

describe("observability/trace-logger: resolveLogsDir", () => {
  it("resuelve una ruta relativa contra cwd", () => {
    expect(resolveLogsDir("logs")).toBe(path.resolve(process.cwd(), "logs"));
  });

  it("respeta una ruta absoluta tal cual", () => {
    const abs = path.resolve(os.tmpdir(), "algun-dir-logs");
    expect(resolveLogsDir(abs)).toBe(abs);
  });
});
