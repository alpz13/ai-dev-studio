# AI Dev Studio

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and [FUTURE.md](./FUTURE.md) for future ideas (web app, Slack, running this against a real repo) not yet planned into phases. This README is just "how to run what already exists."

## Current status: Phase 0 + Phase 1 + Phase 2 + Phase 3 + Phase 4 of the roadmap

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

The experience of "talking" to the Director via chat still isn't there — that's for later on (see the comment in `director.ts`).

## Unit tests (Vitest)

Each file under `src/` has its suite right next to it, in a `__tests__/` subfolder (e.g. `src/feature-state/store.ts` → `src/feature-state/__tests__/store.test.tsx`):

```bash
npm run test           # run everything once
npm run test:watch     # watch mode
npm run test:coverage  # with coverage report
```

What each suite mocks and what runs for real:

- `core/client.test.tsx`, `mcp-servers/*/server.test.tsx`, `agents/{pm,architect,dev,qa,devops}/agent.test.tsx`, `agents/shared/filesystem-agent.test.tsx`, `agents/shared/filesystem-git-client.test.tsx`: mock `@anthropic-ai/sdk` and/or `@modelcontextprotocol/sdk` with `vi.mock` — they test the wiring (what we pass the SDK, how tools get routed, what ends up logged) without calling the API or spinning up a real MCP process.
- `feature-state/store.test.tsx`, `filesystem-git/*.test.tsx`, `observability/trace-logger.test.tsx`, `agents/shared/run-agent-loop.test.tsx`, `agents/shared/mcp-tool-adapter.test.tsx`, `agents/shared/agent-loop-helpers.test.tsx`, `agents/director/slugify.test.tsx`: mock nothing — they run against the real filesystem and real git in temp directories (or are purely pure functions, like `slugify`).
- The two `mcp-servers/*/server.test.tsx` do mock the MCP SDK (so they don't spin up real stdio) but let the real logic underneath run (`FeatureStateStore`, `fs-ops`, `git-ops`) — they capture the handlers the server registers and invoke them directly.
- `agents/shared/feature-state-client.test.tsx`: the three pure functions (`getFeatureState`/`updateFeatureState`/`listPendingFeatures`) are tested without mocks, with a simple fake MCP client; only `connectFeatureStateClient` (which does build the real SDK) uses `vi.doMock` in an isolated test.
- `agents/director/director.test.tsx`: the Director is deterministic orchestration (it doesn't call the Messages API itself), so its tests mock the 5 agent modules and the Feature State MCP client (with an in-memory `Map` that replicates the real shallow merge done by `FeatureStateStore.upsertState`) — without touching any Anthropic/MCP SDK.

The scripts under `scripts/` are not tested (they're CLI wrappers that run `main()` on import and export nothing) — their real logic lives in `src/` and is already covered there.

## Note on how this was built

This scaffold is put together in a cloud sandbox with no access to `registry.npmjs.org` (the environment's network policy), so a real `npm install` can't be run there — neither to exercise `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` against the real libraries, nor to run real Vitest. What does happen there, every time:

- The suites with no ESM module mocks (`store`, `fs-ops`, `git-ops` with real git, `trace-logger`, `mcp-tool-adapter`, `agent-loop-helpers`, `slugify`, `run-agent-loop`, the pure half of `feature-state-client`) are actually run against a minimal shim compatible with the Vitest API, built just for this in the sandbox — it's not real Vitest, but it executes describe/it/expect exactly as written, and it's deleted before every delivery. It found and helped fix real bugs before shipping the code: the broken `Omit` in `trace-logger.ts` (Phase 2), an assertion regex (`/git commit/` didn't match git's real message) in two Phase 2 suites, and in this delivery (Phase 3) a `run-agent-loop.test.tsx` test that captured the `messages` array by reference instead of copying it, so it "saw" a later `push` from the loop and compared incorrectly (fix: `[...params.messages]` at capture time).
- The QA-retry bug fix in `director.ts` (Phase 3) was also verified through real execution, not just review: `runDirector` was run for real (no mocks, with the 5 agent modules and the Feature State MCP client temporarily swapped for in-memory fake implementations) against 7 scenarios — including deliberately reverting the fix once to confirm the retry scenario did in fact fail without it, then reapplying it. The original files were restored byte-for-byte (empty diff) before this delivery.
- Dev's subagents (Phase 4) were verified the same way, through real execution: `createFilesystemAgent` was run for real with a temporary shim of `@anthropic-ai/sdk` (an in-memory queue of canned responses) and `filesystem-git-client.ts` temporarily replaced with a fake MCP client — this confirmed in real code, not just by hand-review, that the parent delegates, the subagent runs with the correct `parentSpanId`, it doesn't inherit `delegate_to_subagent` (no recursion), and the shared MCP client is closed exactly once at the end. `filesystem-git-client.ts` was restored byte-for-byte before this delivery.
- The suites with `vi.mock` on the SDKs (`client`, the 5 `agent.test.tsx`, `filesystem-agent`, `filesystem-git-client`, the two `server.test.tsx`, `director.test.tsx` with its own 5 agents + feature-state-client mocked) can't be run against the shim — they were reviewed by hand against the documented shape of the SDKs. Run `npm run test` on your own machine the first time and flag anything that breaks.
- Typecheck (`npm run typecheck`) always runs, filtering out the errors expected from uninstalled dependencies (`Cannot find module '@anthropic-ai/sdk'`, etc.) so any real type error in the actual logic doesn't get lost in the noise. Phase 3 passes this filtered typecheck clean.

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
   npm run agent:dev -- feat_mi-feature "Crea un archivo README.md que explique este workspace"
   ```

   Check the result in `workspaces/<featureId>/` (with its own git history) and the full trace in `logs/<featureId>.jsonl`.

4. The full pipeline — PM → Architect → Dev → QA → DevOps, via the Director (requires `ANTHROPIC_API_KEY`):

   ```bash
   # start a new feature (generates the featureId from the request)
   npm run studio -- "Quiero poder exportar reportes a CSV"

   # if it ended up 'blocked' or stopped halfway, resume it by its featureId
   npm run studio -- --resume feat_2026-08-24_quiero-exportar-reportes-a-csv
   ```

   Each stage runs against `workspaces/<featureId>/` with its own git history; the state (`currentStage`, which stage is `done`/`failed`, how many QA retries it's had) lives in `features/<featureId>/state.json` via the Feature State MCP; and the full trace of who did what — Director included — ends up in `logs/<featureId>.jsonl`.

5. Standalone Messages API wrapper (requires `ANTHROPIC_API_KEY`):

   ```bash
   npm run test:core
   ```

6. General typecheck:

   ```bash
   npm run typecheck
   ```

7. The full Vitest suite:

   ```bash
   npm run test
   ```

## Next step (Phase 5+)

With the multi-agent pipeline and Dev's subagents already working, the only thing left from ARCHITECTURE.md's original stack is **Phase 5 — Chat with streaming**: an interface (web or bot) that shows progress in real time via the Messaging API with streaming, instead of just via CLI (`npm run studio`). That's where `src/core/client.ts::streamMessage` comes in (Phase 0, still unused outside of `test:core`) — the idea is that the user talks to the Director and watches something like "PM: ✅ specs ready", "Dev: writing code...", live, with delegation to subagents as needed. After that comes Phase 6 (more robust traces and a more polished resume flow).
