# Migration: exposing AI Dev Studio as an MCP server

## Why

AI Dev Studio already has two *internal* MCP servers — `feature-state` and `filesystem-git` — that agents talk to over stdio (see `ARCHITECTURE.md` §4 and `CLAUDE.md`). This project goes one step further: it packages the whole studio itself — the PM → Architect → Dev → QA → DevOps pipeline driven by `runDirector()` — as its own MCP server, so an external MCP host (Claude Desktop, Claude Code, or another agent) can drive a full feature build as a single tool call, the same way `npm run web` already lets a browser do it over HTTP/SSE.

This also fits the project's stated purpose: a practice environment for the full Anthropic stack, including MCP (`CLAUDE.md`, "Project Overview").

## Decisions and why

- **Scope: full pipeline orchestrator, not a consolidation.** We considered just merging the two existing internal servers (`feature-state` + `filesystem-git`) into one process. We rejected that — it adds no new capability, just moves files around. Instead, the new server wraps `runDirector()` itself, giving external hosts a genuinely new capability: "build this feature," not just "read/write this state."
- **Call semantics: fire-and-forget + poll, not blocking.** A full pipeline run makes real Messages API calls across 5 agents and can take several minutes. If the "start a feature" tool call blocked until the whole pipeline finished, it would risk hitting MCP host—side tool-call timeouts on longer builds. Instead, the tool returns a `featureId` immediately (mirroring `src/web/server.ts`'s existing `POST /api/features` behavior) and a separate tool is polled for progress.

## Plan

1. **Write this doc first** (this file) — plan of record before any code changes.
2. **Extract shared start/resume orchestration** into `src/agents/director/director.ts`: a new `startOrResumeFeatureInBackground()` export (plus a `FeatureAlreadyRunningError` class) that does validate → acquire lock → fire `runDirector()` in the background → surface failures → release lock. This logic currently lives inline in `src/web/server.ts`'s `handleStartOrResume`/`surfacePipelineFailure` — it moves out so both the HTTP route and the new MCP tool can share one implementation instead of two copies. `src/web/server.ts` becomes a thin adapter over it.
3. **Build the new MCP server**: `src/mcp-servers/director/server.ts`, following the exact pattern already used by `src/mcp-servers/feature-state/server.ts` and `src/mcp-servers/filesystem-git/server.ts` (`Server`/`StdioServerTransport` from `@modelcontextprotocol/sdk`, `ListToolsRequestSchema`/`CallToolRequestSchema` handlers, `ok()`/`fail()` helpers, one big try/catch, `main()` + stdio connect). Four tools:
   - `run_feature` — `{ featureId?, task? }` → calls `startOrResumeFeatureInBackground`, returns `{ featureId }` immediately.
   - `get_feature_status` — `{ featureId }` → reads the trace log and returns `summarizeTrace()` (durations, tokens used, QA retries, outcome).
   - `get_feature_state` — `{ featureId }` → raw `state.json` passthrough via the `feature-state` MCP client.
   - `list_features` — lists not-yet-done features, via the `feature-state` MCP client.

   No bearer-token auth on this server — it's spawned locally over stdio by a trusted MCP host, the same trust model as the two existing internal servers (unlike the network-facing web server, which requires `AUTH_TOKEN`).
4. **Wire it up**: `package.json` gets a `mcp:director` script; `CLAUDE.md` documents the new server alongside the existing two.
5. **Test coverage**: a new legacy-style test script (`scripts/__tests__/test-director-mcp-client.ts`) exercises tool listing and error paths (missing input, lock conflicts, unknown featureId) without triggering a real, costly pipeline run — keeping it in the same no-`ANTHROPIC_API_KEY`-required bucket as the existing `test:mcp-client` script.
6. **Verify**: typecheck, existing test suite, the new test script, a manual stdio smoke test, and (with a real API key) an end-to-end `run_feature` → poll `get_feature_status` → done walkthrough — then re-check this doc against what was actually built and correct any drift.

## Reused unchanged

- `runDirector()` (`src/agents/director/director.ts`) — the pipeline itself, untouched.
- The trace log + `summarizeTrace()` (`src/observability/trace-logger.ts`, `trace-summary.ts`) — used as-is for progress polling.
- The `feature-state` MCP client (`src/agents/shared/feature-state-client.ts`) — used as-is for state reads, honoring the project's "state is accessed exclusively through the feature-state MCP" convention.
- The web server's lock/fire-and-forget/failure-surfacing pattern (`src/web/server.ts`) — extracted into a shared function rather than copy-pasted.

## New

- `startOrResumeFeatureInBackground()` and `FeatureAlreadyRunningError` in `src/agents/director/director.ts`.
- `src/mcp-servers/director/server.ts` and its 4 tools (`run_feature`, `get_feature_status`, `get_feature_state`, `list_features`).
- `package.json` scripts: `mcp:director`, `test:mcp-director`.
- `scripts/__tests__/test-director-mcp-client.ts`.

## How to use it

Point an MCP host at the server over stdio, dev-mode example:

```json
{
  "mcpServers": {
    "ai-dev-studio-director": {
      "command": "npx",
      "args": ["tsx", "src/mcp-servers/director/server.ts"],
      "cwd": "/path/to/ai-dev-studio",
      "env": { "ANTHROPIC_API_KEY": "..." }
    }
  }
}
```

Typical flow:
1. Call `run_feature` with `{ "task": "add a CSV export button" }` → get back `{ "featureId": "feat_..." }`.
2. Poll `get_feature_status` with that `featureId` every so often until the returned summary's `outcome` is `"done"` (or `"blocked"`, meaning it needs attention).
3. Optionally call `get_feature_state` for the raw stage-by-stage detail, or `list_features` to see everything still in flight.
4. If a feature ends up `"blocked"`, fix whatever caused it and call `run_feature` again with the same `featureId` (no `task`) to resume.

## Known limitations

- The pipeline only keeps running as long as this MCP server process stays alive — closing the host/killing the subprocess stops an in-flight run mid-stage (same lifetime tradeoff `npm run web` already has; state is persisted, so it can be resumed later via `run_feature` with just the `featureId`).
- No built-in cost/token cap beyond `MAX_QA_RETRIES` — a runaway QA↔Dev retry loop or a very large task can still run up real API spend.
