# Production Readiness: Auth, Data Integrity, and Ops Tooling

**Date:** 2026-08-27
**Branch:** refactor
**Scope:** `src/web/server.ts`, `src/feature-state/store.ts`, new `Dockerfile`/`docker-compose.yml`, new CI workflow

---

## Goals

1. Close the two concrete security gaps in the web UI: no auth, and unvalidated `featureId` input reaching filesystem paths.
2. Make feature-state persistence crash-safe and race-safe for a single-instance deployment.
3. Surface pipeline failures into feature state / the UI instead of only the server's stdout.
4. Give the project a real deployment story: build step, container, health check, graceful shutdown, CI.

## Non-goals

- Multi-tenant user accounts, per-user isolation, or rate limiting — deployment target is a single instance for a small, trusted team, not a public service.
- Horizontal scaling / a distributed event bus (e.g. Redis pub/sub) to replace the in-memory `traceEvents` `EventEmitter` — unnecessary at single-instance scale, and would add a runtime dependency the project has otherwise avoided.
- TLS termination in-app — assumed to be handled by a reverse proxy in front of the container.

---

## Section 1: Authentication

### Problem

`src/web/server.ts` has no auth on any route. Anyone who can reach the port can start a pipeline run (real Anthropic API spend) or read any feature's trace/state data.

### Design

A single shared bearer token, read from `process.env.AUTH_TOKEN` at startup. A new `requireAuth(req)` check runs before every route dispatch in `createWebServer`'s request handler, comparing the `Authorization: Bearer <token>` header (or a `?token=` query param for the SSE stream, since `EventSource` cannot set custom headers) against `AUTH_TOKEN` using `crypto.timingSafeEqual` to avoid timing side-channels. Missing/invalid token → `401` with a JSON error body, matching the existing `sendJson` error convention.

`GET /healthz` (added in Section 4) is exempt — container orchestrators need to probe liveness without a credential.

If `AUTH_TOKEN` is unset at startup, the server logs a warning and refuses to start (fail closed, not open) — this is a deliberate behavior change from today's "no auth" default.

### Changes Required

- `src/web/server.ts`: add `requireAuth()`, call it first in the request handler, thread the query-param token case through `handleStream`.
- `.env.example`: document `AUTH_TOKEN`.
- New test in `src/web/__tests__/server.test.tsx`: valid token → 200, missing token → 401, invalid token → 401, `/healthz` reachable without a token.

---

## Section 2: `featureId` input validation

### Problem

`featureId` arrives from user input (POST body in `handleStartOrResume`, URL path segments in the `/stream` and `/summary` routes) and is only `.trim()`'d / `decodeURIComponent`'d before being used to build file paths in `FeatureStateStore` (`features/<featureId>/state.json`) and `TraceLogger` (`logs/<featureId>.jsonl`). A value like `../../etc/passwd` is never rejected.

### Design

Add `isValidFeatureId(id: string): boolean` (new small module, `src/agents/director/slugify.ts` is the natural home since it already owns `generateFeatureId`) enforcing a slug pattern: `^[a-z0-9][a-z0-9_-]{0,127}$`. Apply it:

- In `handleStartOrResume`, when a caller supplies an explicit `featureId` (the generated case from `generateFeatureId(task)` is already safe by construction and doesn't need re-validation, but validating it anyway costs nothing and guards against future changes to the slugify logic).
- In the `/stream` and `/summary` route handlers, immediately after extracting the path segment, before calling `TraceLogger`/`FeatureStateStore`.

Non-matching input → `400` with a JSON error body.

### Changes Required

- `src/agents/director/slugify.ts`: export `isValidFeatureId`.
- `src/web/server.ts`: call it in `handleStartOrResume`, `handleStream`, `handleSummary`; return `400` on failure.
- New tests: valid slugs pass, `../../etc/passwd`-style and empty-string input are rejected with `400`.

---

## Section 3: Crash-safe, race-safe feature state

### Problem

`FeatureStateStore.writeState` does a full `JSON.stringify` + single `fs.writeFile` with no atomicity — a process crash mid-write can leave `state.json` truncated or corrupt. Separately, nothing stops two overlapping requests (e.g. a double-click on "resume") from running the same `featureId` through the Director concurrently, each reading and writing `state.json` independently.

### Design

**Atomic writes:** `writeState` writes to a sibling temp file (`state.json.tmp`) and then `fs.rename()`s it over `state.json`. `rename` is atomic on the same filesystem on both POSIX and Windows (NTFS), so readers never observe a partial write.

**Per-feature lock:** before `runDirector` starts processing a `featureId`, attempt `fs.mkdir(features/<id>/.lock)`. `mkdir` fails with `EEXIST` if the directory already exists, which is what makes this safe as a mutex without adding a locking library. On failure, the web server returns `409 Conflict` ("feature already running"). On success, the lock directory is removed in a `finally` once `runDirector`'s promise settles (success or failure).

### Changes Required

- `src/feature-state/store.ts`: rewrite `writeState` to use temp-file + rename.
- `src/web/server.ts`: add lock acquire/release around the `handleStartOrResume` → `runDirector` path. The lock is a concurrency concern specific to the web server's request handling (rejecting a duplicate HTTP request), not a pipeline concern, so it does not belong in `director.ts` — the terminal `npm run studio` entry point is single-run by construction and never needs it.
- New tests: `writeState` leaves a valid file even if interrupted (simulate via spying on `fs.writeFile`/`rename`); a second start/resume for a feature already holding its lock gets `409`.

---

## Section 4: Surfacing pipeline failures

### Problem

`server.ts:91-93` calls `runDirector(...).catch(err => console.error(...))`. If `runDirector` throws before any per-stage error handling in `pipeline-mechanics.ts` kicks in (e.g. an error constructing the initial state), the failure is invisible to anyone watching the UI — it only exists in the server's stdout.

### Design

The `.catch` handler additionally calls the feature-state MCP client to mark the feature `blocked` with the error message in a `notes` field, and logs a `pipeline_failed` trace event via `TraceLogger` so it shows up in the SSE stream and `/summary` output — using the same client/logger already imported in `server.ts`, no new dependencies.

### Changes Required

- `src/web/server.ts`: expand the `runDirector(...).catch(...)` handler.
- New test: a `runDirector` rejection results in a `blocked` state write and a trace event being logged.

---

## Section 5: Health check and graceful shutdown

### Design

- `GET /healthz`: unauthenticated, returns `200 { status: "ok" }`. No dependency checks (no DB to ping) — liveness only.
- `SIGTERM`/`SIGINT` handlers call `server.close()` to stop accepting new connections, and give in-flight SSE connections a bounded grace period (e.g. 5s) to drain before `process.exit(0)`.

### Changes Required

- `src/web/server.ts`: add the route and the signal handlers in `startWebServer`.
- New test: `/healthz` returns 200 without auth.

---

## Section 6: Build, container, and CI

### Problem

The project runs via `tsx` directly with no compiled output used in practice, and has no Dockerfile, no health-check-aware orchestration config, and no CI beyond the existing Claude-review bots (`.github/workflows/claude*.yml`).

### Design

- `npm run build`: `tsc` (emits to `dist/`, per existing `tsconfig` — already supported, just not wired into a script) followed by a copy step for `src/web/public/*` into `dist/web/public/` (tsc does not copy non-`.ts` assets).
- `Dockerfile`: multi-stage — a `build` stage (`npm ci`, `npm run build`) and a slim `runtime` stage (`npm ci --omit=dev`, copy `dist/` + `package.json`, `CMD ["node", "dist/web/server.js"]`).
- `docker-compose.yml`: one service, volumes for `features/`, `logs/`, `workspaces/`, `env_file: .env`, `restart: unless-stopped`.
- `.dockerignore`: exclude `node_modules`, `features/`, `logs/`, `workspaces/`, `.env`.
- `.github/workflows/ci.yml`: on push/PR, `npm ci`, `npm run typecheck`, `npm test`. Kept as its own workflow file, separate from the existing Claude-review automation.

### Changes Required

- `package.json`: add `build` script.
- New: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.github/workflows/ci.yml`.

---

## Verification

- `npm run typecheck` and `npm test` pass after every section.
- Manual pass once all sections land: `docker compose up` → `GET /healthz` (200, no token) → unauthenticated `GET /api/features` (401) → start a feature with a valid token (202) → repeat the same start request immediately (409) → `docker compose kill` mid-run → `docker compose up` again → confirm the feature resumes from its last completed stage.
