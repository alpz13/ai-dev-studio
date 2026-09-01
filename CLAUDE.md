# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AI Dev Studio** simulates a software development team made of specialized AI agents (PM, Architect, Dev, QA, DevOps) orchestrated by a Director agent. A user describes a feature in natural language; the pipeline produces specs → technical design → code → tests → PR, with real-time progress visible in a chat interface.

The project is an intentional practice environment for the full Anthropic stack: TypeScript SDK, Messages API, MCP, agents, multi-agent orchestration, and subagents. It follows a 7-phase roadmap (see `ARCHITECTURE.md` §6) — **Phases 0–5 are complete** (foundations through streaming chat UI); Phase 6 (robust logging and resume) is in progress.

See `ARCHITECTURE.md` for the full design, stack mapping, logging schema, and phase roadmap.

## Commands

```bash
# Type checking (primary quality gate — no linter configured)
npm run typecheck

# --- Vitest test suite (no API key required) ---
npm test                    # run all vitest tests once
npm run test:watch          # watch mode
npm run test:coverage       # coverage report

# --- Legacy standalone test scripts (no API key required) ---
npm run test:store          # FeatureStateStore logic
npm run test:fs-git         # fs-ops + git-ops against a real temp git repo
npm run test:trace-logger   # TraceLogger
npm run test:agent-helpers  # MCP→Anthropic tool adapter + agent-loop helpers
npm run test:mcp-client     # E2E: exercises all three feature-state MCP tools (launches MCP subprocess)

# --- Require ANTHROPIC_API_KEY in .env ---
npm run test:core           # Messages API wrapper (sendMessage/streamMessage)
npm run agent:dev           # run the Dev agent end-to-end
npm run agent:dev -- feat_my-feature "Create a README.md file that explains this workspace"
npm run studio              # run the full PM→Architect→Dev→QA→DevOps pipeline in the terminal
npm run web                 # start the web UI (http://localhost:3000) — Phase 5
npm run trace-summary -- feat_<featureId>   # print a human-readable trace summary for a feature

# Run an MCP server directly (stdio transport), for manual inspection
npm run mcp:feature-state
npm run mcp:filesystem-git

# Production build (tsc -p tsconfig.build.json + copy static web assets into dist/)
npm run build

# Container (single-instance deployment — see "Deployment" below)
docker compose up --build
```

No build step is needed for local dev — `tsx` runs TypeScript directly. For production, `npm run build` emits runnable output to `./dist/`, consumed by the `Dockerfile`.

**Two test mechanisms coexist**: Vitest (`npm test`) is the primary runner and picks up `**/__tests__/**/*.test.tsx` files in `src/`. The legacy `scripts/__tests__/test-*.ts` scripts predate Vitest and are still valid entry points — run one directly with e.g. `npx tsx scripts/__tests__/test-filesystem-git-ops.ts`.

## Architecture

Full design lives in [ARCHITECTURE.md](./ARCHITECTURE.md). Summary of what's built:

```
src/
├── core/client.ts                        # Phase 0: Anthropic client wrapper (sendMessage/streamMessage)
├── feature-state/store.ts                # Phase 1: pure disk-based state logic, no network deps
├── mcp-servers/
│   ├── feature-state/server.ts           # Phase 1: MCP server wrapping FeatureStateStore (3 tools)
│   └── filesystem-git/server.ts          # Phase 2: MCP server wrapping fs-ops + git-ops (7 tools)
├── filesystem-git/
│   ├── fs-ops.ts                         # Phase 2: sandboxed read/write/list, scoped to WORKSPACE_ROOT
│   └── git-ops.ts                        # Phase 2: git via system CLI (child_process), no extra deps
├── observability/
│   ├── trace-logger.ts                   # Phase 2: append-only JSONL trace log + traceEvents EventEmitter
│   └── trace-summary.ts                  # Phase 6: aggregates stage durations, tokens, QA retries
├── agents/
│   ├── shared/
│   │   ├── mcp-tool-adapter.ts           # MCP tools.list() shape → Anthropic `tools` param shape
│   │   ├── agent-loop-helpers.ts         # extract text/tool_use blocks, build tool_result blocks
│   │   ├── run-agent-loop.ts             # reusable manual Messages API loop (Phase 3+)
│   │   ├── filesystem-agent.ts           # factory: creates any filesystem-git agent by role (Phase 3+)
│   │   ├── filesystem-git-client.ts      # MCP client for the filesystem-git server
│   │   ├── feature-state-client.ts       # MCP client for the feature-state server
│   │   └── mcp-command.ts                # picks tsx+src (dev) vs node+dist (prod, NODE_ENV=production) to spawn MCP server subprocesses
│   ├── director/
│   │   ├── director.ts                   # Phase 3: thin orchestration loop; delegates work to stage defs
│   │   ├── pipeline.ts                   # PIPELINE array + StageDefinition types
│   │   ├── pipeline-mechanics.ts         # retry, resume, error recovery logic
│   │   ├── slugify.ts                    # featureId generation from a task string
│   │   └── stages/{pm,architect,dev,qa,devops}.ts  # one file per pipeline stage
│   └── {pm,architect,dev,qa,devops}/agent.ts  # each just a few lines: system prompt + createFilesystemAgent
└── web/
    ├── server.ts                         # Phase 5: Node HTTP server (no framework); bearer-token auth gate + featureId validation in front of every /api/* route; routes listed below
    └── public/{index.html,style.css,app.js}  # single-page UI consuming SSE stream; prompts for AUTH_TOKEN and attaches it to every request
```

### Key design decisions

**Layering pattern, repeated across each capability**: pure logic module (no SDK deps, unit-testable in isolation) → MCP server that exposes it as tools → agent/client that consumes it over stdio. Keep new capabilities in this shape rather than putting logic directly in the MCP server handler.

**State-as-MCP pattern**: Feature state (`features/<featureId>/state.json`) is accessed exclusively through the `feature-state` MCP server, never read from disk directly by agents. MCP is the uniform integration layer.

**`runAgentLoop` / `createFilesystemAgent`**: The agentic loop lives in `run-agent-loop.ts` and is shared by every agent role. Each role agent (`pm/agent.ts`, `architect/agent.ts`, etc.) is just a factory call to `createFilesystemAgent` in `filesystem-agent.ts` — only the system prompt and `agentRole` differ. This is hand-rolled against the Messages API (no Agent SDK), intentionally, per the roadmap.

**Director architecture**: `director.ts` is a thin orchestration loop that drives the `PIPELINE` array in `pipeline.ts`. Adding a new stage = create `stages/<name>.ts` + add one entry to `PIPELINE`. No other changes needed. Retry/resume logic is isolated in `pipeline-mechanics.ts`.

**SubAgent support** (Phase 4): If `allowSubagents: true` is passed to `createFilesystemAgent`, the loop exposes a synthetic `delegate_to_subagent` tool to the model. When the model calls it, the loop spawns a child agent loop with a child `spanId` (parent = current agent's `spanId`) instead of calling an MCP tool. The model decides when to delegate — no external code forces it.

**Production hardening**: the web server requires a shared bearer token (`AUTH_TOKEN`) on every `/api/*` route, checked with `crypto.timingSafeEqual` (`GET /` and static assets stay open so the browser can load `app.js` and prompt for the token). `isValidFeatureId()` (`slugify.ts`) rejects any `featureId` that isn't a safe slug before it reaches a filesystem path. `FeatureStateStore.acquireLock`/`releaseLock` (atomic `mkdir`, with a 30-minute staleness reclaim so a crash can't block a feature forever) stop two requests from racing the same feature. A `runDirector()` rejection is caught and surfaced into feature state (`status: "blocked"`) and the trace log instead of only reaching the console. This work targets a single-instance, small-trusted-team deployment — no per-user accounts, no horizontal scaling, no in-app TLS.

**Web server routes** (`src/web/server.ts`):
- `GET /healthz` — liveness check, unauthenticated
- `GET /` and static assets (`style.css`, `app.js`) — unauthenticated (the SPA shell carries no feature data)
- `GET /api/features` — list not-yet-done features (requires `Authorization: Bearer <AUTH_TOKEN>`)
- `POST /api/features` — start (`{ task }`) or resume (`{ featureId }`) a feature; `409` if that feature is already running
- `GET /api/features/:featureId/stream` — Server-Sent Events: full history then live events (auth via header or `?token=`, since `EventSource` can't set headers)
- `GET /api/features/:featureId/summary` — stage durations, tokens, QA retries, resume history

**Filesystem sandboxing**: `fs-ops.ts::resolveSafePath` rejects any path that resolves outside `WORKSPACE_ROOT`. Don't bypass it when adding new filesystem tools.

**Tracing model**: Each feature = one `traceId` (= `featureId`); each agent invocation = one `spanId`, with `parentSpanId` pointing to its caller. Events are appended to `logs/<featureId>.jsonl` via `TraceLogger`. The `traceEvents` EventEmitter on the same module lets the web server push live updates over SSE. Note `TraceEventInput`/`TraceEvent` use explicit interfaces (not `Omit<...>`) — mixing named properties with `[k: string]: unknown` collapses `keyof` to `string`, breaking `Pick`/`Omit`.

### Runtime data (gitignored except `.gitkeep`)

- `features/<featureId>/state.json` — feature pipeline state (atomic writes; a sibling `.lock/` directory guards against concurrent runs of the same feature)
- `logs/<featureId>.jsonl` — append-only trace events
- `workspaces/<featureId>/` — the Dev agent's sandboxed, git-versioned working directory

## Key Conventions

- **Language**: The whole project, including this file, is in English.
- **ESM**: `"type": "module"` + `"moduleResolution": "NodeNext"` — use `.js` extensions in imports even for `.ts` source files.
- **No build step in dev**: `tsx` handles JIT transpilation; `dist/` is only for deployment.
- **No extra deps for things the OS already provides**: git operations shell out to the system `git` CLI via `child_process` rather than adding an npm git library.
- **Two TS configs**: `tsconfig.json` for dev/typecheck (includes tests); `tsconfig.build.json` extends it and excludes `**/__tests__/**` so `npm run build` doesn't ship test files (which `import "vitest"`, a devDependency) into the production image.

## Environment Setup

```bash
npm install
cp .env.example .env   # then add ANTHROPIC_API_KEY and AUTH_TOKEN
```

Env vars (see `.env.example`): `ANTHROPIC_API_KEY` (required for anything hitting the Messages API), `ANTHROPIC_MODEL` (defaults to `claude-sonnet-4-5-20250929`), `FEATURES_DIR` (defaults to `./features`), `LOGS_DIR` (defaults to `./logs`), `WORKSPACE_ROOT` (set by the Dev agent when it spawns the filesystem-git MCP server; defaults to `workspaces/default`), `AUTH_TOKEN` (**required** to run `npm run web` — the server refuses to start without it; generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`), `WEB_PORT` (defaults to `3000`).

## Deployment

`Dockerfile` + `docker-compose.yml` package the web UI for a single-instance, small-trusted-team deployment (no per-user accounts, no horizontal scaling, no in-app TLS — put a reverse proxy in front for that):

```bash
cp .env.example .env   # set ANTHROPIC_API_KEY and AUTH_TOKEN
docker compose up --build
curl http://localhost:3000/healthz                                    # unauthenticated liveness check
curl -H "Authorization: Bearer $AUTH_TOKEN" http://localhost:3000/api/features
```

`.github/workflows/ci.yml` runs `npm ci && npm run typecheck && npm test` on push/PR (separate from the `claude*.yml` review-bot workflows). The Docker image itself has not been built/run in this environment — verify with a real `docker compose up --build` before relying on it.
