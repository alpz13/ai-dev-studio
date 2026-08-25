# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AI Dev Studio** simulates a software development team made of specialized AI agents (PM, Architect, Dev, QA, DevOps) orchestrated by a Director agent. A user describes a feature in natural language; the pipeline produces specs → technical design → code → tests → PR, with real-time progress visible in a chat interface.

The project is an intentional practice environment for the full Anthropic stack: TypeScript SDK, Messages API, MCP, agents, multi-agent orchestration, and subagents. It follows a 7-phase roadmap (see `ARCHITECTURE.md` §6) — **Phases 0, 1, and 2 are complete**; there is no Director or multi-agent pipeline yet (Phase 3+).

See `ARCHITECTURE.md` for the full design, stack mapping, logging schema, and phase roadmap.

## Commands

```bash
# Type checking (primary quality gate — no linter configured)
npm run typecheck

# --- No network / no API key required ---
npm run test:store          # FeatureStateStore logic (Phase 1)
npm run test:fs-git         # fs-ops + git-ops against a real temp git repo (Phase 2)
npm run test:trace-logger   # TraceLogger (Phase 2)
npm run test:agent-helpers  # MCP→Anthropic tool adapter + agent-loop helpers (Phase 2)

# --- E2E: launches the relevant MCP server as a subprocess ---
npm run test:mcp-client     # exercises all three feature-state MCP tools

# --- Require ANTHROPIC_API_KEY in .env ---
npm run test:core           # Messages API wrapper (sendMessage/streamMessage)
npm run agent:dev           # run the Dev agent end-to-end
npm run agent:dev -- feat_mi-feature "Crea un archivo README.md que explique este workspace"

# Run an MCP server directly (stdio transport), for manual inspection
npm run mcp:feature-state
npm run mcp:filesystem-git
```

No build step is needed — `tsx` runs TypeScript directly. To emit compiled output: `npx tsc` → `./dist/`.

There is no test runner/framework wired up — each `test:*` script is a standalone `tsx` script under `scripts/` that runs assertions and exits non-zero on failure. Run a "single test" by running that script directly, e.g. `npx tsx scripts/test-filesystem-git-ops.ts`.

## Architecture

Full design lives in [ARCHITECTURE.md](./ARCHITECTURE.md). Summary of what's built so far:

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
├── observability/trace-logger.ts         # Phase 2: append-only JSONL trace log per featureId
└── agents/
    ├── shared/
    │   ├── mcp-tool-adapter.ts           # MCP tools.list() shape → Anthropic `tools` param shape
    │   └── agent-loop-helpers.ts         # extract text/tool_use blocks, build tool_result blocks
    └── dev/agent.ts                      # Phase 2: the Dev agent (manual tool-use loop, no Agent SDK yet)
```

**Layering pattern, repeated across each capability**: pure logic module (no SDK deps, unit-testable in isolation) → MCP server that exposes it as tools → agent/client that consumes it over stdio. `feature-state/store.ts` and `filesystem-git/{fs-ops,git-ops}.ts` are both examples; keep new capabilities in this shape rather than putting logic directly in the MCP server handler.

**State-as-MCP pattern**: Feature state (`features/<featureId>/state.json`) is accessed exclusively through the `feature-state` MCP server, never read from disk directly by agents. This keeps MCP as the uniform integration layer instead of adding a separate DB/state access path.

**Dev agent loop** (`src/agents/dev/agent.ts`): launches `mcp-servers/filesystem-git/server.ts` as a stdio subprocess scoped to a `WORKSPACE_ROOT`, calls `tools.list()`, adapts the tool defs for the Messages API, then runs a manual turn loop (up to `MAX_TURNS`) calling `messages.create` and dispatching any `tool_use` blocks back through the MCP client until the model stops requesting tools. This is hand-rolled, not the Claude Agent SDK — that's intentional per the roadmap (SDK/agent primitives are layered in later phases).

**Filesystem sandboxing**: `fs-ops.ts::resolveSafePath` rejects any relative path that resolves outside `WORKSPACE_ROOT` (`../..` or an absolute path) — this is the only thing standing between the Dev agent and the rest of the filesystem, so don't bypass it when adding new filesystem tools.

**Tracing model**: Each feature = one `traceId` (= `featureId`); each agent invocation = one `spanId`, with `parentSpanId` pointing to its caller (Director, or a parent agent for subagents). Events are appended to `logs/<featureId>.jsonl` via `TraceLogger`. Note `TraceEventInput`/`TraceEvent` in `trace-logger.ts` are written as explicit interfaces rather than `Omit<...>` — mixing named properties with a `[k: string]: unknown` index signature collapses `keyof` to `string`, breaking `Pick`/`Omit`.

### Runtime data (gitignored except `.gitkeep`)

- `features/<featureId>/state.json` — feature pipeline state
- `logs/<featureId>.jsonl` — append-only trace events
- `workspaces/<featureId>/` — the Dev agent's sandboxed, git-versioned working directory

## Key Conventions

- **Language**: All code comments, error messages, and documentation are in Spanish (this file is an exception, kept in English per repo convention for CLAUDE.md).
- **ESM**: `"type": "module"` + `"moduleResolution": "NodeNext"` — use `.js` extensions in imports even for `.ts` source files.
- **No build step in dev**: `tsx` handles JIT transpilation; `dist/` is only for deployment.
- **No extra deps for things the OS already provides**: git operations shell out to the system `git` CLI via `child_process` rather than adding an npm git library.

## Environment Setup

```bash
npm install
cp .env.example .env   # then add ANTHROPIC_API_KEY
```

Env vars (see `.env.example`): `ANTHROPIC_API_KEY` (required for anything hitting the Messages API), `ANTHROPIC_MODEL` (defaults to `claude-sonnet-4-5-20250929`), `FEATURES_DIR` (defaults to `./features`), `LOGS_DIR` (defaults to `./logs`), `WORKSPACE_ROOT` (set by the Dev agent when it spawns the filesystem-git MCP server; defaults to `workspaces/default`).
