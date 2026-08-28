/**
 * Phase 5 — Chat with streaming: a minimal Node HTTP server (no framework,
 * no build step — just `node:http`, consistent with the rest of the
 * project's zero-extra-runtime-deps approach) that lets you start or
 * resume a feature from a browser and watch the Director's pipeline run
 * live, instead of only via `npm run studio` in the terminal.
 *
 * It does not reimplement any pipeline logic: it calls the exact same
 * `runDirector()` from Phase 3, and gets live progress "for free" by
 * subscribing to the `traceEvents` EventEmitter added to
 * src/observability/trace-logger.ts in this phase. No new persistence, no
 * new event schema — this is purely a thin transport layer on top of what
 * already existed.
 *
 * Routes:
 *   GET  /                              the single-page UI (src/web/public/index.html)
 *   GET  /api/features                  list of not-yet-done features (for the "resume" list)
 *   POST /api/features                  start a new feature ({ task }) or resume one ({ featureId })
 *   GET  /api/features/:featureId/stream   Server-Sent Events: full history, then live events
 *   GET  /api/features/:featureId/summary  Phase 6: stage durations, tokens used, QA retries, resume history
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDirector } from "../agents/director/director.js";
import { connectFeatureStateClient, listPendingFeatures, getFeatureState, updateFeatureState, type FeatureStateToolsClient } from "../agents/shared/feature-state-client.js";
import { generateFeatureId, isValidFeatureId } from "../agents/director/slugify.js";
import { traceEvents, TraceLogger, newSpanId, type TraceEvent } from "../observability/trace-logger.js";
import { summarizeTrace } from "../observability/trace-summary.js";
import { FeatureStateStore, type StageName, type StageInfo } from "../feature-state/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, "index.html");

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return false;

  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : url.searchParams.get("token");
  if (!provided) return false;

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function eventKey(event: TraceEvent): string {
  return `${event.spanId}|${event.event}|${event.timestamp}`;
}

async function handleListFeatures(res: ServerResponse): Promise<void> {
  const client = await connectFeatureStateClient();
  try {
    const features = await listPendingFeatures(client as unknown as FeatureStateToolsClient);
    sendJson(res, 200, { features });
  } finally {
    await client.close();
  }
}

async function handleStartOrResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const featureId = typeof body.featureId === "string" && body.featureId.trim() ? body.featureId.trim() : undefined;
  const task = typeof body.task === "string" && body.task.trim() ? body.task.trim() : undefined;

  if (!featureId && !task) {
    sendJson(res, 400, { error: "Provide either featureId (to resume) or task (to start a new feature)." });
    return;
  }

  const resolvedFeatureId = featureId ?? generateFeatureId(task!);

  if (!isValidFeatureId(resolvedFeatureId)) {
    sendJson(res, 400, { error: `Invalid featureId "${resolvedFeatureId}".` });
    return;
  }

  // A duplicate start/resume request for a feature that's already running
  // races two Director runs against the same state.json. The lock is a
  // web-server-level concern (rejecting a duplicate HTTP request), not a
  // pipeline concern, so it lives here rather than in director.ts.
  const lockStore = new FeatureStateStore();
  const acquired = await lockStore.acquireLock(resolvedFeatureId);
  if (!acquired) {
    sendJson(res, 409, { error: `Feature "${resolvedFeatureId}" is already running.` });
    return;
  }

  // Fire and forget: a full pipeline run makes several real Messages API
  // calls and can take a while. The caller gets the featureId back right
  // away and watches progress over the SSE stream below — runDirector
  // already persists every step to Feature State + the trace log itself,
  // so a closed browser tab never loses work, it just stops watching it.
  runDirector({ featureId: resolvedFeatureId, task })
    .catch((err) => surfacePipelineFailure(resolvedFeatureId, err))
    .finally(() => void lockStore.releaseLock(resolvedFeatureId));

  sendJson(res, 202, { featureId: resolvedFeatureId });
}

async function surfacePipelineFailure(featureId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[web] runDirector(${featureId}) failed:`, err);

  // This runs off the end of a fire-and-forget chain (see startFeature above)
  // whose only remaining step is lockStore.releaseLock in a .finally(). If
  // anything below throws — e.g. the feature-state MCP subprocess fails to
  // spawn — that rejection must not propagate, or it becomes an unhandled
  // promise rejection that crashes the whole web server. So: never reject:
  // catch and log any secondary failure instead of letting it surface.
  try {
    const client = await connectFeatureStateClient();
    try {
      const featureClient = client as unknown as FeatureStateToolsClient;
      const existing = await getFeatureState(featureClient, featureId);
      const currentStage: StageName = existing?.currentStage ?? "PM";
      const stages = { [currentStage]: { status: "failed", notes: message } } as Partial<
        Record<StageName, StageInfo>
      >;
      await updateFeatureState(featureClient, { featureId, status: "blocked", stages });
    } finally {
      await client.close();
    }

    const logger = new TraceLogger();
    await logger.log({
      traceId: featureId,
      spanId: newSpanId("agt_director"),
      agentRole: "Director",
      event: "error",
      note: message,
    });
  } catch (secondaryErr) {
    console.error(
      `[web] surfacePipelineFailure(${featureId}) failed while surfacing original error "${message}":`,
      secondaryErr,
    );
  }
}

async function handleStream(featureId: string, res: ServerResponse, req: IncomingMessage): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders(); // send headers immediately so clients don't block waiting for the first write

  // De-duplicated by (spanId, event, timestamp): the live listener is
  // registered before the historical read completes, so an event that
  // lands in that narrow window can otherwise show up both live and in
  // history. Wrapping every send through here keeps the client from ever
  // seeing it twice, regardless of which path wins the race.
  const seen = new Set<string>();
  const send = (event: TraceEvent) => {
    const key = eventKey(event);
    if (seen.has(key)) return;
    seen.add(key);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const onEvent = (event: TraceEvent) => send(event);
  traceEvents.on(featureId, onEvent);

  // Keeps intermediate proxies/browsers from timing out an idle connection.
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);

  // Register cleanup BEFORE any await so it fires even if the client closes
  // the connection while we're still reading history from disk.
  req.on("close", () => {
    clearInterval(keepAlive);
    traceEvents.off(featureId, onEvent);
  });

  const logger = new TraceLogger();
  const history = await logger.readTrace(featureId);
  for (const event of history) send(event);
}

async function handleSummary(featureId: string, res: ServerResponse): Promise<void> {
  const logger = new TraceLogger();
  const events = await logger.readTrace(featureId);
  if (events.length === 0) {
    sendJson(res, 404, { error: `No trace found for "${featureId}".` });
    return;
  }
  sendJson(res, 200, summarizeTrace(featureId, events));
}

export interface WebServerOptions {
  port?: number;
}

export function createWebServer(_opts: WebServerOptions = {}): Server {
  if (!process.env.AUTH_TOKEN) {
    throw new Error("AUTH_TOKEN must be set — refusing to start the web server without authentication.");
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const { pathname } = url;

        if (!isAuthorized(req, url)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        if (req.method === "GET" && pathname === "/") {
          const html = await readFile(INDEX_HTML_PATH, "utf-8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }

        // Serve static assets (style.css, app.js) from public/
        if (req.method === "GET" && !pathname.startsWith("/api/")) {
          const ext = path.extname(pathname);
          const mime = STATIC_MIME[ext];
          if (mime) {
            const filePath = path.join(PUBLIC_DIR, path.basename(pathname));
            try {
              const content = await readFile(filePath, "utf-8");
              res.writeHead(200, { "Content-Type": mime });
              res.end(content);
            } catch {
              sendJson(res, 404, { error: "not found" });
            }
            return;
          }
        }

        if (req.method === "GET" && pathname === "/api/features") {
          await handleListFeatures(res);
          return;
        }

        if (req.method === "POST" && pathname === "/api/features") {
          await handleStartOrResume(req, res);
          return;
        }

        const streamMatch = pathname.match(/^\/api\/features\/([^/]+)\/stream$/);
        if (req.method === "GET" && streamMatch) {
          const featureId = decodeURIComponent(streamMatch[1]);
          if (!isValidFeatureId(featureId)) {
            sendJson(res, 400, { error: `Invalid featureId "${featureId}".` });
            return;
          }
          await handleStream(featureId, res, req);
          return;
        }

        const summaryMatch = pathname.match(/^\/api\/features\/([^/]+)\/summary$/);
        if (req.method === "GET" && summaryMatch) {
          const featureId = decodeURIComponent(summaryMatch[1]);
          if (!isValidFeatureId(featureId)) {
            sendJson(res, 400, { error: `Invalid featureId "${featureId}".` });
            return;
          }
          await handleSummary(featureId, res);
          return;
        }

        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) sendJson(res, 500, { error: message });
        else res.end();
      }
    })();
  });
}

export function startWebServer(opts: WebServerOptions = {}): Promise<{ server: Server; port: number }> {
  const server = createWebServer(opts);
  const port = opts.port ?? Number(process.env.WEB_PORT ?? 3000);
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, port }));
  });
}
