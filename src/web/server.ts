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
import { startOrResumeFeatureInBackground, FeatureAlreadyRunningError } from "../agents/director/run-feature.js";
import { connectFeatureStateClient, listPendingFeatures, type FeatureStateToolsClient } from "../agents/shared/feature-state-client.js";
import { isValidFeatureId } from "../agents/director/slugify.js";
import { traceEvents, TraceLogger, type TraceEvent } from "../observability/trace-logger.js";
import { summarizeTrace } from "../observability/trace-summary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, "index.html");

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

/**
 * `allowQueryToken` is only true for the SSE stream route: `EventSource`
 * can't set an Authorization header, so that one route accepts `?token=`.
 * Every other route requires the header, so tokens don't leak into access
 * logs / browser history for ordinary requests.
 */
function isAuthorized(req: IncomingMessage, url: URL, allowQueryToken: boolean): boolean {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return false;

  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : (allowQueryToken ? url.searchParams.get("token") : null);
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

  try {
    const result = await startOrResumeFeatureInBackground({ featureId, task });
    sendJson(res, 202, { featureId: result.featureId });
  } catch (err) {
    if (err instanceof FeatureAlreadyRunningError) {
      sendJson(res, 409, { error: err.message });
      return;
    }
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
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

        if (req.method === "GET" && pathname === "/healthz") {
          sendJson(res, 200, { status: "ok" });
          return;
        }

        // The SPA shell (HTML/CSS/JS) is served unauthenticated, like
        // /healthz above: it carries no feature data or secrets, and the
        // browser has to be able to load app.js before it can prompt for a
        // token at all. Everything under /api/ — the only thing that touches
        // pipeline state — stays behind the auth gate below.
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

        const isStreamRoute = /^\/api\/features\/[^/]+\/stream$/.test(pathname);
        if (!isAuthorized(req, url, isStreamRoute)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
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

  const shutdown = () => {
    console.error("[web] shutting down...");
    server.close(() => process.exit(0));
    // Force-exit if in-flight SSE connections haven't drained in time.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, port }));
  });
}
