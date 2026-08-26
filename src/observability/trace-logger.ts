/**
 * Traces per feature/agent — see ARCHITECTURE.md section 3.
 *
 * traceId = featureId, spanId = one turn/invocation of an agent,
 * parentSpanId = who invoked it (useful later on for nested
 * subagents). One append-only JSONL file per featureId in logs/.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type TraceEventType = "agent_start" | "agent_end" | "tool_call" | "tool_result" | "message" | "error";

// NOTE: TraceEventInput is defined explicitly (not via Omit<TraceEvent, "timestamp">)
// because combining named properties with an index signature [k: string]: unknown
// makes `keyof` collapse to `string`, so Pick/Omit stop "seeing" the real fields.
export interface TraceEventBase {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  agentRole: string;
  event: TraceEventType;
}

// The reusable context an agent builds once (traceId/spanId/agentRole)
// and then passes to every log() call, adding `event` each time — that's
// why it does NOT carry `event` (unlike TraceEventBase). See
// src/agents/shared/run-agent-loop.ts for the use case.
export type TraceContext = Omit<TraceEventBase, "event">;

export type TraceEventInput = TraceEventBase & { [extra: string]: unknown };

export interface TraceEvent extends TraceEventBase {
  timestamp: string;
  [extra: string]: unknown;
}

export function resolveLogsDir(baseDir: string = process.env.LOGS_DIR ?? "logs"): string {
  return path.isAbsolute(baseDir) ? baseDir : path.resolve(process.cwd(), baseDir);
}

export class TraceLogger {
  constructor(private readonly logsDir: string = resolveLogsDir()) {}

  private filePath(traceId: string): string {
    return path.join(this.logsDir, `${traceId}.jsonl`);
  }

  async log(event: TraceEventInput): Promise<TraceEvent> {
    await fs.mkdir(this.logsDir, { recursive: true });
    const full: TraceEvent = { ...event, timestamp: new Date().toISOString() };
    await fs.appendFile(this.filePath(event.traceId), `${JSON.stringify(full)}\n`, "utf-8");
    return full;
  }

  async readTrace(traceId: string): Promise<TraceEvent[]> {
    try {
      const raw = await fs.readFile(this.filePath(traceId), "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TraceEvent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}

let counter = 0;
/** Human-readable span id, unique within the process, e.g. agt_dev_1755882012345_1 */
export function newSpanId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}
