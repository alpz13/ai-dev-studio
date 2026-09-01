# Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared-token auth, `featureId` input validation, crash/race-safe feature-state persistence, surfaced pipeline failures, a health check + graceful shutdown, and a Docker/CI deployment story to ai-dev-studio's web UI — closing the gaps identified for a single-instance, small-team production deployment.

**Architecture:** All changes are additive to existing modules (`src/web/server.ts`, `src/feature-state/store.ts`, `src/agents/director/slugify.ts`) plus new deployment artifacts (`Dockerfile`, `docker-compose.yml`, CI workflow). No restructuring of the existing MCP/agent architecture, no new runtime dependencies.

**Tech Stack:** Node.js built-ins (`node:http`, `node:crypto`, `node:fs`), Vitest, Docker, GitHub Actions — everything already in the project; no new npm packages.

**Spec:** `docs/superpowers/specs/2026-08-27-production-readiness-design.md`

## Global Constraints

- No new runtime npm dependencies — the project shells out to OS-provided tools / built-in Node modules only (see CLAUDE.md "Key Conventions").
- ESM throughout: import paths use explicit `.js` extensions even in `.ts` source (`moduleResolution: NodeNext`).
- Every task must leave `npm run typecheck` and `npm test` passing before its commit.
- Vitest test files use the `.test.tsx` extension under `__tests__/`, matching this codebase's existing convention (confirmed in `src/web/__tests__/server.test.tsx`, `src/feature-state/__tests__/store.test.tsx`), even where no JSX is used.
- Deployment target is a single instance for a small, trusted team: no per-user accounts, no distributed pub/sub, no in-app TLS termination (a reverse proxy handles TLS in front of the container).

---

### Task 1: `isValidFeatureId` — reject path-traversal input

**Files:**
- Modify: `src/agents/director/slugify.ts`
- Test: `src/agents/director/__tests__/slugify.test.tsx`

**Interfaces:**
- Produces: `isValidFeatureId(featureId: string): boolean` — consumed by Task 4 in `src/web/server.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/agents/director/__tests__/slugify.test.tsx`, change the import line at the top from:
```ts
import { generateFeatureId, slugify } from "../../../agents/director/slugify.js";
```
to:
```ts
import { generateFeatureId, isValidFeatureId, slugify } from "../../../agents/director/slugify.js";
```

Then append this new `describe` block at the end of the file:
```ts
describe("agents/director/slugify: isValidFeatureId", () => {
  it("accepts a normally generated featureId", () => {
    expect(isValidFeatureId("feat_2026-08-24_export-to-csv")).toBe(true);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidFeatureId("../../etc/passwd")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidFeatureId("")).toBe(false);
  });

  it("rejects a value starting with a hyphen or underscore", () => {
    expect(isValidFeatureId("-feat_x")).toBe(false);
    expect(isValidFeatureId("_feat_x")).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(isValidFeatureId("Feat_X")).toBe(false);
  });

  it("rejects a slash", () => {
    expect(isValidFeatureId("feat/x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/agents/director/__tests__/slugify.test.tsx`
Expected: FAIL — `isValidFeatureId` is not exported from `slugify.js`.

- [ ] **Step 3: Implement `isValidFeatureId`**

Append to `src/agents/director/slugify.ts`:
```ts
const FEATURE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * Guards against path traversal: featureId is used to build filesystem
 * paths in FeatureStateStore and TraceLogger, so anything outside this
 * slug shape must be rejected before it reaches a path.join() call.
 */
export function isValidFeatureId(featureId: string): boolean {
  return FEATURE_ID_PATTERN.test(featureId);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/agents/director/__tests__/slugify.test.tsx`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/agents/director/slugify.ts src/agents/director/__tests__/slugify.test.tsx
git commit -m "feat: add isValidFeatureId to reject path-traversal featureId input"
```

---

### Task 2: Atomic state writes and a per-feature lock in `FeatureStateStore`

**Files:**
- Modify: `src/feature-state/store.ts:72-78` (rewrite `writeState`), add `acquireLock`/`releaseLock`
- Test: `src/feature-state/__tests__/store.test.tsx`

**Interfaces:**
- Produces: `FeatureStateStore.acquireLock(featureId: string): Promise<boolean>`, `FeatureStateStore.releaseLock(featureId: string): Promise<void>` — consumed by Task 5 in `src/web/server.ts`.
- `writeState`'s public signature is unchanged; only its internal durability behavior changes.

- [ ] **Step 1: Write the failing tests**

In `src/feature-state/__tests__/store.test.tsx`, change the vitest import line from:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
```
to:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

Then append these two `describe` blocks at the end of the file, before the closing of the file (after the existing `resolveFeaturesDir` describe block):
```ts
describe("FeatureStateStore: atomic writes", () => {
  let root: string;
  let store: FeatureStateStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-test-"));
    store = new FeatureStateStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not corrupt state.json if the final rename step fails", async () => {
    await store.upsertState({ featureId: "feat_demo", title: "Before" });

    const fsPromises = (await import("node:fs")).promises;
    const spy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("disk full"));

    await expect(store.upsertState({ featureId: "feat_demo", title: "After" })).rejects.toThrow("disk full");

    const stillThere = await store.readState("feat_demo");
    expect(stillThere?.title).toBe("Before");

    spy.mockRestore();
  });
});

describe("FeatureStateStore: locking", () => {
  let root: string;
  let store: FeatureStateStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-test-"));
    store = new FeatureStateStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("acquireLock returns true the first time and false while still held", async () => {
    const first = await store.acquireLock("feat_demo");
    const second = await store.acquireLock("feat_demo");

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("releaseLock allows acquiring the same feature again", async () => {
    await store.acquireLock("feat_demo");

    await store.releaseLock("feat_demo");
    const reacquired = await store.acquireLock("feat_demo");

    expect(reacquired).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/feature-state/__tests__/store.test.tsx`
Expected: FAIL — the rename-failure test fails because `upsertState` currently resolves instead of rejecting (no `rename` call exists yet to fail), and the locking tests fail because `acquireLock`/`releaseLock` are not functions.

- [ ] **Step 3: Implement atomic writes and locking**

In `src/feature-state/store.ts`, replace the `writeState` method:
```ts
  async writeState(state: FeatureState): Promise<FeatureState> {
    const dir = path.join(this.featuresDir, state.featureId);
    await fs.mkdir(dir, { recursive: true });
    const toWrite: FeatureState = { ...state, updatedAt: new Date().toISOString() };
    await fs.writeFile(this.statePath(state.featureId), JSON.stringify(toWrite, null, 2), "utf-8");
    return toWrite;
  }
```
with:
```ts
  async writeState(state: FeatureState): Promise<FeatureState> {
    const dir = path.join(this.featuresDir, state.featureId);
    await fs.mkdir(dir, { recursive: true });
    const toWrite: FeatureState = { ...state, updatedAt: new Date().toISOString() };
    const finalPath = this.statePath(state.featureId);
    const tmpPath = `${finalPath}.tmp`;
    // Write to a temp file, then rename over the real path: rename() is
    // atomic on the same filesystem on both POSIX and Windows, so a crash
    // or failure mid-write can never leave state.json truncated/corrupt.
    await fs.writeFile(tmpPath, JSON.stringify(toWrite, null, 2), "utf-8");
    await fs.rename(tmpPath, finalPath);
    return toWrite;
  }

  private lockPath(featureId: string): string {
    return path.join(this.featuresDir, featureId, ".lock");
  }

  /**
   * Atomic mutex via mkdir, which fails with EEXIST if the directory
   * already exists — no locking library needed. Returns false if another
   * run already holds the lock for this featureId.
   */
  async acquireLock(featureId: string): Promise<boolean> {
    await fs.mkdir(path.join(this.featuresDir, featureId), { recursive: true });
    try {
      await fs.mkdir(this.lockPath(featureId));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  async releaseLock(featureId: string): Promise<void> {
    await fs.rm(this.lockPath(featureId), { recursive: true, force: true });
  }
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/feature-state/__tests__/store.test.tsx`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/feature-state/store.ts src/feature-state/__tests__/store.test.tsx
git commit -m "feat: make FeatureStateStore writes atomic and add a per-feature lock"
```

---

### Task 3: Shared-token authentication on the web server

**Files:**
- Modify: `src/web/server.ts`
- Modify: `src/web/__tests__/server.test.tsx`
- Modify: `.env.example`

**Interfaces:**
- Produces: internal `isAuthorized(req, url)` helper (not exported — used only within `server.ts`).
- Adds a hard requirement: `createWebServer()` now throws if `process.env.AUTH_TOKEN` is unset.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/web/__tests__/server.test.tsx` with:
```tsx
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The web layer is a thin transport on top of runDirector() (Phase 3) and
// the Feature State MCP client (Phase 1/3) — both already have their own
// real-logic tests elsewhere, so here they're mocked the same way
// agents/director/__tests__/director.test.tsx mocks the 5 role agents:
// control what they "say", assert on how the HTTP layer wires them up.
const runDirectorMock = vi.fn(async (opts: { featureId: string; task?: string }) => ({
  featureId: opts.featureId,
  finalState: { featureId: opts.featureId, title: opts.task ?? opts.featureId, status: "done", currentStage: "DevOps", stages: {}, updatedAt: new Date().toISOString() },
}));

vi.mock("../../agents/director/director.js", () => ({ runDirector: runDirectorMock }));

const closeMock = vi.fn(async () => {});
const listPendingFeaturesMock = vi.fn(async () => [] as unknown[]);
const connectFeatureStateClientMock = vi.fn(async () => ({ close: closeMock }));

vi.mock("../../agents/shared/feature-state-client.js", () => ({
  connectFeatureStateClient: connectFeatureStateClientMock,
  listPendingFeatures: listPendingFeaturesMock,
}));

const { createWebServer } = await import("../server.js");
const { TraceLogger } = await import("../../observability/trace-logger.js");

const AUTH_TOKEN = "test-token";

function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${AUTH_TOKEN}` } });
}

async function readSseEvents(response: Response, count: number, signal: AbortSignal): Promise<any[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: any[] = [];
  while (events.length < count && !signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice("data: ".length)));
    }
  }
  await reader.cancel().catch(() => {});
  return events;
}

describe("web/server", () => {
  let logsDir: string;
  let featuresDir: string;
  let server: ReturnType<typeof createWebServer>;
  let baseUrl: string;

  beforeEach(async () => {
    logsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-web-test-"));
    process.env.LOGS_DIR = logsDir;
    featuresDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-features-test-"));
    process.env.FEATURES_DIR = featuresDir;
    process.env.AUTH_TOKEN = AUTH_TOKEN;

    runDirectorMock.mockClear();
    connectFeatureStateClientMock.mockClear();
    listPendingFeaturesMock.mockClear();
    closeMock.mockClear();

    server = createWebServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(logsDir, { recursive: true, force: true });
    await fs.rm(featuresDir, { recursive: true, force: true });
    delete process.env.LOGS_DIR;
    delete process.env.FEATURES_DIR;
    delete process.env.AUTH_TOKEN;
  });

  it("createWebServer throws if AUTH_TOKEN is not set", () => {
    delete process.env.AUTH_TOKEN;
    expect(() => createWebServer()).toThrow(/AUTH_TOKEN/);
  });

  it("a request without a token is rejected with 401", async () => {
    const res = await fetch(`${baseUrl}/api/features`);
    expect(res.status).toBe(401);
  });

  it("a request with the wrong token is rejected with 401", async () => {
    const res = await fetch(`${baseUrl}/api/features`, { headers: { Authorization: "Bearer wrong-token" } });
    expect(res.status).toBe(401);
  });

  it("GET / serves the single-page UI", async () => {
    const res = await authedFetch(`${baseUrl}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/AI Dev Studio/);
    expect(body).toMatch(/app\.js/);
  });

  it("GET /api/features returns the pending features from the Feature State MCP client", async () => {
    listPendingFeaturesMock.mockResolvedValueOnce([
      { featureId: "feat_x", title: "X", status: "blocked", currentStage: "QA", stages: {}, updatedAt: "now" },
    ]);

    const res = await authedFetch(`${baseUrl}/api/features`);
    const body = await res.json() as { features: Array<{ featureId: string }> };

    expect(res.status).toBe(200);
    expect(body.features).toHaveLength(1);
    expect(body.features[0].featureId).toBe("feat_x");
    expect(connectFeatureStateClientMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("POST /api/features with a task generates a featureId, starts runDirector, and returns immediately", async () => {
    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "Add a CSV export endpoint" }),
    });
    const body = await res.json() as { featureId: string };

    expect(res.status).toBe(202);
    expect(body.featureId).toMatch(/^feat_\d{4}-\d{2}-\d{2}_add-a-csv-export-endpoint$/);
    expect(runDirectorMock).toHaveBeenCalledTimes(1);
    expect(runDirectorMock.mock.calls[0][0]).toEqual({ featureId: body.featureId, task: "Add a CSV export endpoint" });
  });

  it("POST /api/features with a featureId resumes it without generating a new one", async () => {
    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "feat_2026-08-24_resume-me" }),
    });
    const body = await res.json() as { featureId: string };

    expect(res.status).toBe(202);
    expect(body.featureId).toBe("feat_2026-08-24_resume-me");
    expect(runDirectorMock).toHaveBeenCalledWith({ featureId: "feat_2026-08-24_resume-me", task: undefined });
  });

  it("POST /api/features with neither task nor featureId rejects with 400 and never calls runDirector", async () => {
    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(runDirectorMock).not.toHaveBeenCalled();
  });

  it("GET /api/features/:id/stream replays existing history and then streams live events", async () => {
    const featureId = "feat_2026-08-24_stream-test";
    const logger = new TraceLogger(logsDir);
    await logger.log({ traceId: featureId, spanId: "agt_director_1", agentRole: "Director", event: "agent_start" });

    const controller = new AbortController();
    const res = await authedFetch(`${baseUrl}/api/features/${featureId}/stream`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    // First event comes from history (written before we ever connected).
    const [historical] = await readSseEvents(res, 1, controller.signal);
    expect(historical.event).toBe("agent_start");
    expect(historical.agentRole).toBe("Director");

    // A second logger.log() call for the same featureId, made after the
    // stream is open, must arrive over the live traceEvents channel.
    await logger.log({ traceId: featureId, spanId: "agt_pm_1", agentRole: "PM", event: "agent_end", output: "specs ready" });

    const res2 = await authedFetch(`${baseUrl}/api/features/${featureId}/stream`, { signal: controller.signal });
    const both = await readSseEvents(res2, 2, controller.signal);
    expect(both.map((e) => e.event)).toEqual(["agent_start", "agent_end"]);

    controller.abort();
  });

  it("GET /api/features/:id/stream accepts the token as a ?token= query param, for EventSource clients", async () => {
    const featureId = "feat_2026-08-25_query-token-test";
    const controller = new AbortController();

    const res = await fetch(`${baseUrl}/api/features/${featureId}/stream?token=${AUTH_TOKEN}`, { signal: controller.signal });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    controller.abort();
  });

  it("GET /api/features/:id/summary returns 404 when no trace exists for that feature", async () => {
    const res = await authedFetch(`${baseUrl}/api/features/feat_does_not_exist/summary`);

    expect(res.status).toBe(404);
  });

  it("GET /api/features/:id/summary summarizes the feature's trace (stage durations, tokens, QA retries)", async () => {
    const featureId = "feat_2026-08-26_summary-test";
    const logger = new TraceLogger(logsDir);
    await logger.log({ traceId: featureId, spanId: "agt_director_1", agentRole: "Director", event: "agent_start" });
    await logger.log({ traceId: featureId, spanId: "agt_pm_1", agentRole: "PM", event: "agent_start" });
    await logger.log({ traceId: featureId, spanId: "agt_pm_1", agentRole: "PM", event: "agent_end", tokensUsed: 120 });
    await logger.log({ traceId: featureId, spanId: "agt_director_1", agentRole: "Director", event: "agent_end", output: "Pipeline complete." });

    const res = await authedFetch(`${baseUrl}/api/features/${featureId}/summary`);
    const body = await res.json() as { featureId: string; outcome: string; totalTokensUsed: number; stages: Array<{ stage: string; tokensUsed: number }> };

    expect(res.status).toBe(200);
    expect(body.featureId).toBe(featureId);
    expect(body.outcome).toBe("done");
    expect(body.totalTokensUsed).toBe(120);
    expect(body.stages.find((s) => s.stage === "PM")?.tokensUsed).toBe(120);
  });

  it("closing the client connection unsubscribes it from traceEvents (no leak across requests)", async () => {
    const { traceEvents } = await import("../../observability/trace-logger.js");
    const featureId = "feat_2026-08-24_cleanup-test";

    const controller = new AbortController();
    const res = await authedFetch(`${baseUrl}/api/features/${featureId}/stream`, { signal: controller.signal });
    // res.flushHeaders() in the server sends headers synchronously before any await,
    // so the listener is already registered by the time fetch() resolves — no read needed.
    const reader = res.body!.getReader();

    expect(traceEvents.listenerCount(featureId)).toBeGreaterThan(0);

    controller.abort();
    await reader.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(traceEvents.listenerCount(featureId)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `npx vitest run src/web/__tests__/server.test.tsx`
Expected: FAIL — `createWebServer()` doesn't throw without `AUTH_TOKEN`, and unauthenticated requests currently return 200/202/etc instead of 401.

- [ ] **Step 3: Implement the auth check**

In `src/web/server.ts`, add the import at the top (after the existing `node:http` import):
```ts
import { timingSafeEqual } from "node:crypto";
```

Add this helper function after the `STATIC_MIME` constant declaration:
```ts
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
```

Replace the start of `createWebServer`:
```ts
export function createWebServer(_opts: WebServerOptions = {}): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const { pathname } = url;

        if (req.method === "GET" && pathname === "/") {
```
with:
```ts
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
```

- [ ] **Step 4: Document the new env var**

Append to `.env.example`:
```
# Required: shared bearer token the web UI/API checks on every request
# (except /healthz). Generate one with: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
AUTH_TOKEN=
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `npx vitest run src/web/__tests__/server.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/web/server.ts src/web/__tests__/server.test.tsx .env.example
git commit -m "feat: require a shared bearer token on all web server routes"
```

---

### Task 4: Wire `featureId` validation into the web server routes

**Files:**
- Modify: `src/web/server.ts`
- Modify: `src/web/__tests__/server.test.tsx`

**Interfaces:**
- Consumes: `isValidFeatureId(featureId: string): boolean` from Task 1 (`src/agents/director/slugify.js`).

- [ ] **Step 1: Write the failing tests**

Append to the `describe("web/server", ...)` block in `src/web/__tests__/server.test.tsx` (anywhere after the existing `it` blocks, before the closing `});` of the describe):
```ts
  it("POST /api/features with an invalid featureId rejects with 400", async () => {
    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "../../etc/passwd" }),
    });

    expect(res.status).toBe(400);
    expect(runDirectorMock).not.toHaveBeenCalled();
  });

  it("GET /api/features/:id/stream with an invalid featureId rejects with 400", async () => {
    const res = await authedFetch(`${baseUrl}/api/features/${encodeURIComponent("../../etc/passwd")}/stream`);
    expect(res.status).toBe(400);
  });

  it("GET /api/features/:id/summary with an invalid featureId rejects with 400", async () => {
    const res = await authedFetch(`${baseUrl}/api/features/${encodeURIComponent("../../etc/passwd")}/summary`);
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/web/__tests__/server.test.tsx`
Expected: FAIL — all three requests currently proceed past the missing validation (400 expected, something else returned).

- [ ] **Step 3: Implement validation**

In `src/web/server.ts`, update the slugify import:
```ts
import { generateFeatureId } from "../agents/director/slugify.js";
```
to:
```ts
import { generateFeatureId, isValidFeatureId } from "../agents/director/slugify.js";
```

In `handleStartOrResume`, replace:
```ts
  const resolvedFeatureId = featureId ?? generateFeatureId(task!);

  // Fire and forget: a full pipeline run makes several real Messages API
```
with:
```ts
  const resolvedFeatureId = featureId ?? generateFeatureId(task!);

  if (!isValidFeatureId(resolvedFeatureId)) {
    sendJson(res, 400, { error: `Invalid featureId "${resolvedFeatureId}".` });
    return;
  }

  // Fire and forget: a full pipeline run makes several real Messages API
```

Replace the stream/summary route matching block:
```ts
        const streamMatch = pathname.match(/^\/api\/features\/([^/]+)\/stream$/);
        if (req.method === "GET" && streamMatch) {
          await handleStream(decodeURIComponent(streamMatch[1]), res, req);
          return;
        }

        const summaryMatch = pathname.match(/^\/api\/features\/([^/]+)\/summary$/);
        if (req.method === "GET" && summaryMatch) {
          await handleSummary(decodeURIComponent(summaryMatch[1]), res);
          return;
        }
```
with:
```ts
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/web/__tests__/server.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/web/server.ts src/web/__tests__/server.test.tsx
git commit -m "feat: reject invalid featureId input on all web server routes"
```

---

### Task 5: Per-feature lock and surfaced pipeline failures

**Files:**
- Modify: `src/web/server.ts`
- Modify: `src/web/__tests__/server.test.tsx`

**Interfaces:**
- Consumes: `FeatureStateStore.acquireLock`/`releaseLock` from Task 2 (`src/feature-state/store.js`); `getFeatureState`/`updateFeatureState` from `src/agents/shared/feature-state-client.js` (already exist); `newSpanId` from `src/observability/trace-logger.js` (already exists).

- [ ] **Step 1: Write the failing tests**

In `src/web/__tests__/server.test.tsx`, replace the mock block:
```ts
const closeMock = vi.fn(async () => {});
const listPendingFeaturesMock = vi.fn(async () => [] as unknown[]);
const connectFeatureStateClientMock = vi.fn(async () => ({ close: closeMock }));

vi.mock("../../agents/shared/feature-state-client.js", () => ({
  connectFeatureStateClient: connectFeatureStateClientMock,
  listPendingFeatures: listPendingFeaturesMock,
}));
```
with:
```ts
const closeMock = vi.fn(async () => {});
const listPendingFeaturesMock = vi.fn(async () => [] as unknown[]);
const connectFeatureStateClientMock = vi.fn(async () => ({ close: closeMock }));
const getFeatureStateMock = vi.fn(async () => null as unknown);
const updateFeatureStateMock = vi.fn(async (_client: unknown, input: unknown) => input);

vi.mock("../../agents/shared/feature-state-client.js", () => ({
  connectFeatureStateClient: connectFeatureStateClientMock,
  listPendingFeatures: listPendingFeaturesMock,
  getFeatureState: getFeatureStateMock,
  updateFeatureState: updateFeatureStateMock,
}));
```

In the `beforeEach`, replace:
```ts
    runDirectorMock.mockClear();
    connectFeatureStateClientMock.mockClear();
    listPendingFeaturesMock.mockClear();
    closeMock.mockClear();
```
with:
```ts
    runDirectorMock.mockClear();
    connectFeatureStateClientMock.mockClear();
    listPendingFeaturesMock.mockClear();
    getFeatureStateMock.mockClear();
    updateFeatureStateMock.mockClear();
    closeMock.mockClear();
```

Then append these two tests to the `describe("web/server", ...)` block:
```ts
  it("POST /api/features rejects a duplicate start for a feature already running with 409", async () => {
    let resolveRun!: () => void;
    runDirectorMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRun = () => resolve({ featureId: "feat_locked", finalState: {} as any });
      }),
    );

    const first = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "feat_locked" }),
    });
    expect(first.status).toBe(202);

    const second = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "feat_locked" }),
    });
    expect(second.status).toBe(409);

    resolveRun();
  });

  it("a runDirector failure marks the feature blocked and logs a trace error event", async () => {
    runDirectorMock.mockImplementationOnce(async () => {
      throw new Error("Dev agent crashed");
    });

    const res = await authedFetch(`${baseUrl}/api/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featureId: "feat_will-fail" }),
    });
    expect(res.status).toBe(202);

    // runDirector's rejection is handled asynchronously (fire-and-forget) —
    // give the microtask/timer queue a turn before asserting on its side effects.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updateFeatureStateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ featureId: "feat_will-fail", status: "blocked" }),
    );

    const logger = new TraceLogger(logsDir);
    const trace = await logger.readTrace("feat_will-fail");
    expect(trace.some((e) => e.event === "error" && e.note === "Dev agent crashed")).toBe(true);
  });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/web/__tests__/server.test.tsx`
Expected: FAIL — no lock exists yet (second request also returns 202), and no failure-surfacing exists yet (`updateFeatureStateMock` never called, no trace error event logged).

- [ ] **Step 3: Implement the lock and failure surfacing**

In `src/web/server.ts`, update these two import lines:
```ts
import { connectFeatureStateClient, listPendingFeatures, type FeatureStateToolsClient } from "../agents/shared/feature-state-client.js";
import { traceEvents, TraceLogger, type TraceEvent } from "../observability/trace-logger.js";
```
to:
```ts
import { connectFeatureStateClient, listPendingFeatures, getFeatureState, updateFeatureState, type FeatureStateToolsClient } from "../agents/shared/feature-state-client.js";
import { traceEvents, TraceLogger, newSpanId, type TraceEvent } from "../observability/trace-logger.js";
import { FeatureStateStore, type StageName, type StageInfo } from "../feature-state/store.js";
```

Replace the whole `handleStartOrResume` function:
```ts
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

  // Fire and forget: a full pipeline run makes several real Messages API
  // calls and can take a while. The caller gets the featureId back right
  // away and watches progress over the SSE stream below — runDirector
  // already persists every step to Feature State + the trace log itself,
  // so a closed browser tab never loses work, it just stops watching it.
  runDirector({ featureId: resolvedFeatureId, task }).catch((err) => {
    console.error(`[web] runDirector(${resolvedFeatureId}) failed:`, err);
  });

  sendJson(res, 202, { featureId: resolvedFeatureId });
}
```
with:
```ts
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

  const client = await connectFeatureStateClient();
  try {
    const featureClient = client as unknown as FeatureStateToolsClient;
    const existing = await getFeatureState(featureClient, featureId);
    const currentStage: StageName = existing?.currentStage ?? "PM";
    const stages = { [currentStage]: { status: "failed", notes: message } } as Partial<Record<StageName, StageInfo>>;
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
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/web/__tests__/server.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/web/server.ts src/web/__tests__/server.test.tsx
git commit -m "feat: lock features against duplicate runs, surface pipeline failures into state"
```

---

### Task 6: `/healthz` and graceful shutdown

**Files:**
- Modify: `src/web/server.ts`
- Modify: `src/web/__tests__/server.test.tsx`

**Interfaces:**
- None new — this task only adds a route and a shutdown handler local to `server.ts`.

- [ ] **Step 1: Write the failing test**

Append to the `describe("web/server", ...)` block in `src/web/__tests__/server.test.tsx`:
```ts
  it("GET /healthz returns 200 without requiring a token", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = await res.json() as { status: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
  });
```

- [ ] **Step 2: Run tests, verify it fails**

Run: `npx vitest run src/web/__tests__/server.test.tsx`
Expected: FAIL — `/healthz` currently hits the auth check with no token and returns 401.

- [ ] **Step 3: Implement `/healthz`**

In `src/web/server.ts`, replace:
```ts
        const url = new URL(req.url ?? "/", "http://localhost");
        const { pathname } = url;

        if (!isAuthorized(req, url)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        if (req.method === "GET" && pathname === "/") {
```
with:
```ts
        const url = new URL(req.url ?? "/", "http://localhost");
        const { pathname } = url;

        if (req.method === "GET" && pathname === "/healthz") {
          sendJson(res, 200, { status: "ok" });
          return;
        }

        if (!isAuthorized(req, url)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        if (req.method === "GET" && pathname === "/") {
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/web/__tests__/server.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 5: Implement graceful shutdown**

This isn't covered by an automated test (there's no reliable way to send real OS signals to the vitest process without killing the test run) — it's verified manually in Task 8's Docker pass. In `src/web/server.ts`, replace:
```ts
export function startWebServer(opts: WebServerOptions = {}): Promise<{ server: Server; port: number }> {
  const server = createWebServer(opts);
  const port = opts.port ?? Number(process.env.WEB_PORT ?? 3000);
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, port }));
  });
}
```
with:
```ts
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
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/web/server.ts src/web/__tests__/server.test.tsx
git commit -m "feat: add /healthz endpoint and graceful shutdown on SIGTERM/SIGINT"
```

---

### Task 7: Real build step for production

**Files:**
- Create: `scripts/copy-static-assets.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run build` — a working `dist/` tree, consumed by Task 8's Dockerfile.

- [ ] **Step 1: Create the static asset copy script**

Create `scripts/copy-static-assets.mjs`:
```js
// tsc compiles src/**/*.ts into dist/src/**/*.js but does not copy non-.ts
// assets. src/web/server.ts resolves its PUBLIC_DIR relative to its own
// compiled location (dist/src/web/), so the static files need to land there.
import { cp } from "node:fs/promises";

await cp("src/web/public", "dist/src/web/public", { recursive: true });
console.log("Copied src/web/public -> dist/src/web/public");
```

- [ ] **Step 2: Add the `build` script**

In `package.json`, add this entry to `"scripts"` (alongside the existing `"typecheck"` entry):
```json
    "build": "tsc && node scripts/copy-static-assets.mjs",
```

- [ ] **Step 3: Verify the build works**

Run: `npm run build`
Expected: succeeds, and both `dist/scripts/run-web.js` and `dist/src/web/public/index.html` exist afterward. Confirm with:

Run: `node -e "require('node:fs').accessSync('dist/scripts/run-web.js'); require('node:fs').accessSync('dist/src/web/public/index.html'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/copy-static-assets.mjs
git commit -m "feat: add a real npm run build for production (tsc + static asset copy)"
```

---

### Task 8: Dockerfile, docker-compose, and `.dockerignore`

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: `npm run build` from Task 7; `AUTH_TOKEN`/`ANTHROPIC_API_KEY`/`FEATURES_DIR`/`LOGS_DIR`/`WEB_PORT` env vars already read by `src/web/server.ts` and `scripts/run-web.ts`.

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/scripts/run-web.js"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
services:
  web:
    build: .
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - ./features:/app/features
      - ./logs:/app/logs
      - ./workspaces:/app/workspaces
    restart: unless-stopped
```

- [ ] **Step 3: Create `.dockerignore`**

```
node_modules
dist
features
logs
workspaces
.env
.git
```

- [ ] **Step 4: Verify the image builds**

Run: `docker build -t ai-dev-studio .`
Expected: builds successfully with no errors. (Requires Docker installed locally; if it isn't, note this step as pending and verify it in Task 9's CI-adjacent manual pass before considering the plan done — see Verification section below.)

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "feat: add Dockerfile and docker-compose for single-instance deployment"
```

---

### Task 9: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- None — a standalone GitHub Actions workflow, kept separate from the existing `.github/workflows/claude*.yml` review bots.

- [ ] **Step 1: Create the workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Verify**

Run: `npm ci && npm run typecheck && npm test` locally — these are the exact three commands the workflow runs, so a local green run is the closest thing to a pre-flight check without pushing. Full validation happens on the next push/PR once this file is committed.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run typecheck and tests on push and pull request"
```

---

## Verification

After all 9 tasks are complete:

1. `npm run typecheck` and `npm test` both pass.
2. Manual end-to-end pass (per the spec):
   - `cp .env.example .env`, fill in `ANTHROPIC_API_KEY` and a generated `AUTH_TOKEN`.
   - `docker compose up --build`.
   - `curl http://localhost:3000/healthz` → `200 {"status":"ok"}`, no token needed.
   - `curl http://localhost:3000/api/features` (no token) → `401`.
   - `curl -H "Authorization: Bearer $AUTH_TOKEN" -X POST http://localhost:3000/api/features -d '{"task":"test"}' -H "Content-Type: application/json"` → `202` with a `featureId`.
   - Repeat the same POST immediately with the same `featureId` → `409`.
   - `docker compose kill` mid-run, then `docker compose up` again → confirm the feature resumes from its last completed stage (check `/api/features/<id>/summary`).
