/**
 * Trazas por feature/agente — ver ARCHITECTURE.md sección 3.
 *
 * traceId = featureId, spanId = un turno/invocación de un agente,
 * parentSpanId = quién lo invocó (útil más adelante para subagentes
 * anidados). Un archivo JSONL append-only por featureId en logs/.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type TraceEventType = "agent_start" | "agent_end" | "tool_call" | "tool_result" | "message" | "error";

// OJO: TraceEventInput se define de forma explícita (no vía Omit<TraceEvent, "timestamp">)
// porque combinar propiedades nombradas con un índice de firma [k: string]: unknown
// hace que `keyof` colapse a `string`, y Pick/Omit dejan de "ver" los campos reales.
export interface TraceEventBase {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  agentRole: string;
  event: TraceEventType;
}

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
/** Id de span legible y único dentro del proceso, ej. agt_dev_1755882012345_1 */
export function newSpanId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}
