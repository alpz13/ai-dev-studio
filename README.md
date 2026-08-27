# AI Dev Studio

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and [FUTURE.md](./FUTURE.md) for future ideas (web app, Slack, running this against a real repo) not yet planned into phases. This README is just "how to run what already exists."

## Current status: Phase 0 through Phase 6 of the roadmap (all phases complete)

- **Phase 0** — `src/core/client.ts`: a minimal wrapper over `@anthropic-ai/sdk` (Messages API), with `sendMessage` and `streamMessage`.
- **Phase 1** — `src/feature-state/store.ts` + `src/mcp-servers/feature-state/server.ts`: the first MCP server (the "Feature State MCP" from section 4 of ARCHITECTURE.md), which stores on disk which stage each feature is at.
- **Phase 2** — the first real agent, running on its own (no Director yet):
  - `src/filesystem-git/` (`fs-ops.ts` + `git-ops.ts`) and `src/mcp-servers/filesystem-git/server.ts`: a second MCP server that gives the Dev agent a scoped file workspace (it can't leave its own folder) with real git underneath (via the system CLI, no extra dependencies).
  - `src/observability/trace-logger.ts`: the per-feature/per-agent trace logger (JSONL in `logs/<featureId>.jsonl`) — already started in this phase instead of leaving it for the end, so every agent added from here on logs from day one.
  - `src/agents/shared/`: the MCP→Anthropic tool adapter and the agentic-loop helpers (extracting text/tool_use, building tool_result).
  - `src/agents/dev/agent.ts`: the Dev agent — receives a task and runs a manual tool-use loop against the filesystem-git MCP until it finishes, logging every step.
- **Phase 3** — the full multi-agent pipeline, orchestrated by the Director:
  - `src/agents/shared/run-agent-loop.ts` + `src/agents/shared/filesystem-agent.ts`: the Phase 2 agentic loop was extracted into a generic, reusable engine (`createFilesystemAgent`), so it wouldn't be repeated 5 times.
  - `src/agents/{pm,architect,dev,qa,devops}/agent.ts`: the 5 agents on the team, each with its own system prompt and its own role in the trace. The Dev agent was rewritten on top of the generic engine (same behavior as in Phase 2).
  - `src/agents/shared/feature-state-client.ts`: the MCP client toward the Feature State MCP from Phase 1, now used by the Director (not just by test scripts).
  - `src/agents/director/director.ts`: the Director — **deterministic** orchestration (not an agent that calls Claude) that runs PM → Architect → Dev → QA → DevOps in order, checks and updates feature state at each step (so it can be resumed if it stopped midway — see ARCHITECTURE.md section 4), and if QA doesn't approve it sends the feature back to Dev up to `MAX_QA_RETRIES` (2) times before marking it `blocked`.
  - `src/agents/director/slugify.ts`: generates the `featureId` (`feat_<date>_<request-slug>`) when you start a new feature without giving it an id yourself.
  - `scripts/run-studio.ts` (`npm run studio`): the CLI for starting or resuming a feature.

- **Phase 4** — SubAgents: the Dev agent, and only Dev, can split a large task into pieces by file/module:
  - `src/agents/shared/run-agent-loop.ts`: the loop now accepts an optional `subagentTool` — a synthetic tool (`delegate_to_subagent`, not coming from the MCP) that, if present, gets added to what the model sees. When the model invokes it, the loop doesn't ask the MCP: it calls `subagentTool.run()`.
  - `src/agents/shared/filesystem-agent.ts`: `createFilesystemAgent` now accepts `{ allowSubagents: true }`. When it's turned on, it builds that `run()` for real — it launches a nested subagent (same `agentRole`, same MCP client/workspace, but with its own `spanId` and `parentSpanId` = the parent agent's spanId) and returns its summary to the parent as if it were the result of just another tool. Only one level of nesting: the subagent itself does not receive `delegate_to_subagent` — no infinite recursion.
  - `src/agents/dev/agent.ts`: `runDevAgent` is created with `{ allowSubagents: true }`, and the system prompt explains when it makes sense to delegate (several separable pieces) and when it doesn't (a single-file task).
  - Who decides to split the task: the model itself, in the middle of its normal loop — not a code rule or the Director. This is the most faithful demonstration of "subagents" as a stack concept (see ARCHITECTURE.md section 2).

- **Phase 5** — Chat with streaming: watch the pipeline run live from a browser instead of only via `npm run studio`:
  - `src/observability/trace-logger.ts`: `TraceLogger.log()` now also emits on a process-wide `traceEvents` EventEmitter, keyed by `traceId` (the featureId), in addition to writing the same event to the JSONL file as before — same event schema, just a second, live delivery path. Agents and the Director didn't need to change at all to get this: every `TraceLogger` instance already funnels through the same emitter.
  - `src/web/server.ts` (`npm run web`): a small `node:http` server, no framework — starting or resuming a feature is `POST /api/features`; `GET /api/features` lists not-yet-`done` features to resume; `GET /api/features/:featureId/stream` is a Server-Sent Events endpoint that replays a feature's full history from disk and then streams live `traceEvents` for it, de-duplicated so a client that connects in the narrow window between "read history" and "subscribe live" never sees an event twice.
  - `src/web/public/index.html`: a single self-contained page (no build step, no external scripts) — a form to start a feature or resume a pending one, five stage badges (PM/Architect/Dev/QA/DevOps) that light up live from the event stream, and a scrolling raw event log underneath.
  - This is stage-level progress streaming (discrete events: agent started, tool called, agent finished), not token-by-token text streaming — each agent's own reply from Claude still comes back as one block per turn (`run-agent-loop.ts` doesn't stream yet; `src/core/client.ts::streamMessage` from Phase 0 remains available for that, unused outside `test:core`, if a later phase wants it).

- **Phase 6** — Robust logging and resume: end-to-end token accounting, a per-feature trace summary, and a real fix to a resume-correctness bug (not just cosmetic logging):
  - `src/agents/shared/run-agent-loop.ts`: gained an optional `onUsage?: (usage: {inputTokens, outputTokens}) => void` callback, called once at the end with the totals summed across every turn — additive, so `runAgentLoop`'s existing `Promise<string>` contract (relied on everywhere) didn't change. `src/agents/shared/filesystem-agent.ts` uses it to log `tokensUsed` on every `agent_end` event, for both the top-level agent and any subagent it delegates to (Phase 4).
  - **The qaRetries bug**: `director.ts` used to keep `qaRetries` as a local variable, reset to `0` on every call to `runDirector`. Resuming a feature that crashed mid QA-retry-cycle silently sent Dev the *original* "implement the feature" task instead of "QA found issues, fix them" — the retry context was lost, even though the pipeline looked like it was resuming correctly. Fixed by persisting `qaRetries` on `FeatureState` (`src/feature-state/store.ts`), threading it through the Feature State MCP's `update_feature_state` tool (`src/mcp-servers/feature-state/server.ts`), and having `director.ts` read it back with `state.qaRetries ?? 0` instead of hardcoding `0`.
  - **Resume messaging**: on resuming an existing, not-yet-`done` feature, the Director now logs one explicit trace message distinguishing *interrupted* (status was `in_progress` — the process died mid-stage, nothing marked it failed) from *blocked* (status was `blocked` — QA exhausted its retries, or a stage threw, and this is a deliberate retry after a fix). Surfaced in both the CLI (`scripts/run-studio.ts` prints it before the run starts) and the web UI (via the trace stream, same as any other event).
  - `src/observability/trace-summary.ts`: a pure `summarizeTrace(featureId, events)` function that turns a feature's raw JSONL trace into stage-by-stage durations and token counts, total QA retries, resume history, and a best-effort outcome (`done`/`blocked`/`in_progress`/`unknown`) — read from the Director's own trace events, no coupling to `FeatureState`. Correctly separates a subagent's token usage (counted) from its duration (not double-counted on top of its parent's).
  - `scripts/trace-summary.ts` (`npm run trace-summary -- <featureId>`): CLI readout built on `summarizeTrace`. `GET /api/features/:featureId/summary` in `src/web/server.ts` exposes the same data over HTTP, and `src/web/public/index.html` renders it as a panel once the Director's own span ends (`agent_end` or `error`), right under the live event log.

The experience of "talking" to the Director via chat (as opposed to watching its progress) still isn't there — that's for later on (see the comment in `director.ts`).

## Unit tests (Vitest)

Each file under `src/` has its suite right next to it, in a `__tests__/` subfolder (e.g. `src/feature-state/store.ts` → `src/feature-state/__tests__/store.test.tsx`):

```bash
npm run test           # run everything once
npm run test:watch     # watch mode
npm run test:coverage  # with coverage report
```

What each suite mocks and what runs for real:

- `core/client.test.tsx`, `mcp-servers/*/server.test.tsx`, `agents/{pm,architect,dev,qa,devops}/agent.test.tsx`, `agents/shared/filesystem-agent.test.tsx`, `agents/shared/filesystem-git-client.test.tsx`: mock `@anthropic-ai/sdk` and/or `@modelcontextprotocol/sdk` with `vi.mock` — they test the wiring (what we pass the SDK, how tools get routed, what ends up logged) without calling the API or spinning up a real MCP process.
- `feature-state/store.test.tsx`, `filesystem-git/*.test.tsx`, `observability/trace-logger.test.tsx`, `observability/trace-summary.test.tsx`, `agents/shared/run-agent-loop.test.tsx`, `agents/shared/mcp-tool-adapter.test.tsx`, `agents/shared/agent-loop-helpers.test.tsx`, `agents/director/slugify.test.tsx`: mock nothing — they run against the real filesystem and real git in temp directories, or are purely pure functions (`slugify`, `summarizeTrace`).
- The two `mcp-servers/*/server.test.tsx` do mock the MCP SDK (so they don't spin up real stdio) but let the real logic underneath run (`FeatureStateStore`, `fs-ops`, `git-ops`) — they capture the handlers the server registers and invoke them directly.
- `agents/shared/feature-state-client.test.tsx`: the three pure functions (`getFeatureState`/`updateFeatureState`/`listPendingFeatures`) are tested without mocks, with a simple fake MCP client; only `connectFeatureStateClient` (which does build the real SDK) uses `vi.doMock` in an isolated test.
- `agents/director/director.test.tsx`: the Director is deterministic orchestration (it doesn't call the Messages API itself), so its tests mock the 5 agent modules and the Feature State MCP client (with an in-memory `Map` that replicates the real shallow merge done by `FeatureStateStore.upsertState`) — without touching any Anthropic/MCP SDK.
- `web/server.test.tsx`: mocks `runDirector` and the Feature State MCP client the same way `director.test.tsx` does (the web layer doesn't touch the Anthropic/MCP SDKs directly either), but runs a real `node:http` server on an ephemeral port and hits it with real `fetch` calls — including reading the SSE stream endpoint's response body directly, decoding `data: ...\n\n` chunks by hand, since Node has no global `EventSource` to test against.

The scripts under `scripts/` are not tested (they're CLI wrappers that run `main()` on import and export nothing) — their real logic lives in `src/` and is already covered there.

## Note on how this was built

This scaffold is put together in a cloud sandbox with no access to `registry.npmjs.org` (the environment's network policy), so a real `npm install` can't be run there — neither to exercise `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` against the real libraries, nor to run real Vitest. What does happen there, every time:

- The suites with no ESM module mocks (`store`, `fs-ops`, `git-ops` with real git, `trace-logger`, `trace-summary`, `mcp-tool-adapter`, `agent-loop-helpers`, `slugify`, `run-agent-loop`, the pure half of `feature-state-client`) have historically been run against a minimal shim compatible with the Vitest API, built just for this in the sandbox — not real Vitest, but it executes describe/it/expect exactly as written, and it's deleted before every delivery. It found and helped fix real bugs before shipping the code: the broken `Omit` in `trace-logger.ts` (Phase 2), an assertion regex (`/git commit/` didn't match git's real message) in two Phase 2 suites, and in Phase 3, a `run-agent-loop.test.tsx` test that captured the `messages` array by reference instead of copying it, so it "saw" a later `push` from the loop and compared incorrectly (fix: `[...params.messages]` at capture time). This delivery's sandbox had no `node_modules` and no npm cache at all (not even `@types/node`, and `registry.npmjs.org` returned 403 rather than just being unreachable), so instead of rebuilding that shim, the new pure logic (`store.ts`'s `qaRetries` merge, `summarizeTrace()`) was driven directly with `tsx` + `node:assert` against realistic event/state fixtures — same "real execution, not just review" bar, different mechanism; see the Phase 6 bullet below for specifics.
- The QA-retry bug fix in `director.ts` (Phase 3) was also verified through real execution, not just review: `runDirector` was run for real (no mocks, with the 5 agent modules and the Feature State MCP client temporarily swapped for in-memory fake implementations) against 7 scenarios — including deliberately reverting the fix once to confirm the retry scenario did in fact fail without it, then reapplying it. The original files were restored byte-for-byte (empty diff) before this delivery.
- Dev's subagents (Phase 4) were verified the same way, through real execution: `createFilesystemAgent` was run for real with a temporary shim of `@anthropic-ai/sdk` (an in-memory queue of canned responses) and `filesystem-git-client.ts` temporarily replaced with a fake MCP client — this confirmed in real code, not just by hand-review, that the parent delegates, the subagent runs with the correct `parentSpanId`, it doesn't inherit `delegate_to_subagent` (no recursion), and the shared MCP client is closed exactly once at the end. `filesystem-git-client.ts` was restored byte-for-byte before this delivery.
- The web server (Phase 5) was verified the same way: `director.ts` and `feature-state-client.ts` were temporarily replaced with fakes (a fake `runDirector` that runs a real 5-stage loop through the real `TraceLogger`, so the live event stream is genuine, not scripted), then a real `node:http` server was started and driven end to end with real `fetch` calls — starting a feature, watching all 12 expected events arrive over SSE in the right order while the fake pipeline was still running, reconnecting after completion to confirm history replay, and confirming a client that aborts its connection gets unsubscribed from `traceEvents` (no listener leak). Both files were restored byte-for-byte before this delivery.
- Phase 6's qaRetries fix — the actual bug this phase set out to fix — was verified through real execution end to end, not just review: the 5 role-agent modules and `feature-state-client.ts` were temporarily replaced with fakes (an in-memory `Map` doing the same shallow merge as the real `FeatureStateStore`), and the real `director.ts` was driven through 4 scenarios — resuming a feature interrupted mid QA-retry-cycle (confirms Dev gets the "fix QA issues" task, not the original one, and the trace is tagged `resumeKind: "interrupted"`), resuming right at `MAX_QA_RETRIES` (confirms it blocks immediately instead of resetting the count), resuming a `blocked` feature (tagged `resumeKind: "blocked"`), and a brand-new feature (no resume tag at all). Separately, the Feature State MCP server's new `qaRetries` wiring (input schema + handler) was verified against a real `FeatureStateStore` on disk, using a minimal hand-written stub of `@modelcontextprotocol/sdk`'s server classes (the sandbox has no way to install the real package) just to satisfy the import — the store logic underneath is 100% real. `summarizeTrace()` (pure, no I/O, no external deps) and the `qaRetries` shallow-merge in `store.ts` were run directly via `tsx` with real inputs and `node:assert`, no fakes needed at all. All swapped files were restored byte-for-byte (confirmed via `diff`) before this delivery, and no stub `node_modules` was left behind.
- The suites with `vi.mock` on the SDKs (`client`, the 5 `agent.test.tsx`, `filesystem-agent`, `filesystem-git-client`, the two `server.test.tsx`, `director.test.tsx` with its own 5 agents + feature-state-client mocked) can't be run against the shim — they were reviewed by hand against the documented shape of the SDKs. Run `npm run test` on your own machine the first time and flag anything that breaks.
- Typecheck (`npm run typecheck`) normally runs with the errors expected from uninstalled dependencies filtered out, so any real type error in the actual logic doesn't get lost in the noise — Phases 3–5 passed this filtered typecheck clean. Phase 6's sandbox had no `node_modules` and no npm cache at all (see above), so `tsc` couldn't produce even that filtered signal this time; every new/modified file that imports an external package was instead smoke-imported for real via `tsx` against minimal hand-written stubs of `@modelcontextprotocol/sdk`/`@anthropic-ai/sdk`/`dotenv` (enough surface to satisfy the imports, not to be functionally complete) to at least catch syntax and import-resolution errors, on top of the real-execution scenarios below. Run `npm run typecheck` yourself after `npm install` to get the full signal.

## How to run it

```bash
npm install
cp .env.example .env   # and set your ANTHROPIC_API_KEY
```

1. Tests with no network, no API key (should pass just like in the sandbox):

   ```bash
   npm run test:store
   npm run test:fs-git
   npm run test:trace-logger
   npm run test:agent-helpers
   ```

2. Feature State MCP end to end (launches the server as a subprocess and talks to it as an MCP client):

   ```bash
   npm run test:mcp-client
   ```

3. The Dev agent alone, without the rest of the pipeline (requires `ANTHROPIC_API_KEY`):

   ```bash
   npm run agent:dev
   # or with your own task:
   npm run agent:dev -- feat_my-feature "Create a README.md file that explains this workspace"
   ```

   Check the result in `workspaces/<featureId>/` (with its own git history) and the full trace in `logs/<featureId>.jsonl`.

4. The full pipeline — PM → Architect → Dev → QA → DevOps, via the Director (requires `ANTHROPIC_API_KEY`):

   ```bash
   # start a new feature (generates the featureId from the request)
   npm run studio -- "I want to be able to export reports to CSV"

   # if it ended up 'blocked' or stopped halfway, resume it by its featureId
   npm run studio -- --resume feat_2026-08-24_i-want-to-be-able-to-export-reports-to-csv
   ```

   Each stage runs against `workspaces/<featureId>/` with its own git history; the state (`currentStage`, which stage is `done`/`failed`, how many QA retries it's had) lives in `features/<featureId>/state.json` via the Feature State MCP; and the full trace of who did what — Director included — ends up in `logs/<featureId>.jsonl`.

5. Standalone Messages API wrapper (requires `ANTHROPIC_API_KEY`):

   ```bash
   npm run test:core
   ```

6. The web UI — start or resume a feature and watch it run live (requires `ANTHROPIC_API_KEY`):

   ```bash
   npm run web
   # then open http://localhost:3000
   # or on another port:
   WEB_PORT=4000 npm run web
   ```

7. Trace summary for a feature you've already run (stage durations, tokens used, QA retries, resume history):

   ```bash
   npm run trace-summary -- <featureId>
   ```

   The same data is also available while (or after) the pipeline runs via the web UI (step 6), rendered as a panel under the live log once the run finishes, and over HTTP at `GET /api/features/<featureId>/summary`.

8. General typecheck:

   ```bash
   npm run typecheck
   ```

9. The full Vitest suite:

   ```bash
   npm run test
   ```

## What's next

All 7 phases (0 through 6) of ARCHITECTURE.md's original roadmap are done: the multi-agent pipeline, Dev's subagents, live progress streaming, and now token accounting, a trace summary, and a real fix to the qaRetries resume bug. There's no numbered "next phase" left — from here, growth is expected to come from [FUTURE.md](./FUTURE.md)'s speculative topics, none of which is scheduled yet:

- **Slack integration** (FUTURE.md §2): the `traceEvents` EventEmitter added in Phase 5 was deliberately designed with more than one subscriber in mind — a Slack app editing a single channel message as events come in could be "just another subscriber" of the same stream the web UI already uses, not a separate integration.
- **Refining the web chat app** (FUTURE.md §1): today it's stage-level event streaming, not token-by-token text streaming — `src/core/client.ts::streamMessage` from Phase 0 exists but no agent uses it inside `run-agent-loop.ts` yet.
- **Running against a real git repo instead of a disposable workspace** (FUTURE.md §3): needs branch isolation (no `git_checkout_branch` tool exists yet), a finer-grained read/write scope than "anywhere inside `WORKSPACE_ROOT`", and a real test-runner MCP so QA's verdict is a green/red run instead of a reasoned read of the diff — none of this is a roadmap phase, it's a safety prerequisite for the day this points at real code.
