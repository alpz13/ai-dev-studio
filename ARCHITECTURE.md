# AI Dev Studio — Design Document

> Status: initial draft (brainstorming → design). Date: 2026-08-22.

## 1. Summary

AI Dev Studio simulates a small software development team made of specialized AI agents. The user requests a feature in natural language (e.g. "add a CSV export endpoint") and a pipeline of agents — Product Manager, Architect, Developer, QA, and DevOps — coordinated by a Director agent, convert it into specs, technical design, code, tests, and a PR, all visible in real time via chat.

The secondary goal (and original motivation) of the project is to practice, organically and without forcing it, the full Anthropic development suite: TypeScript SDK, Claude API / Messages API, Messaging API with streaming, custom MCP servers, MCP clients, individual agents, multi-agent orchestration, and subagents.

## 2. Project parts mapped to the stack

| Project part | Stack point being practiced |
|---|---|
| Node/TS backend wrapping Claude calls | **TypeScript SDK** (`@anthropic-ai/sdk`) for direct calls and streaming |
| Endpoints for one-off tasks (classify a bug, summarize a ticket) | **Claude API / Messages API** (single-turn, function calling) |
| Real-time chat (web or Telegram/Slack bot) where the user watches agents work | **Messaging API** with response streaming |
| Custom servers: filesystem+git, tickets (mock Jira), test runner, notifications, feature state | **MCP** — custom servers in Node (`@modelcontextprotocol/sdk`) |
| The Director agent discovering and calling those tools dynamically | **MCP client** — consumer side of the protocol |
| PM, Architect, Dev, QA, DevOps as roles with their own prompts/context/tools | Individual **agents** via the Claude Agent SDK |
| The Director deciding order, passing context between roles, resolving conflicts (e.g. QA fails and returns to Dev) | **Multi-agent**: sequential and parallel pipeline |
| The Dev agent, faced with a large task, spawning one agent per file/module and consolidating results | **SubAgents** |

## 3. Logging and traceability (who said what, in which feature)

Trace-style model (inspired by OpenTelemetry, home-grown implementation):

- `traceId` = `featureId` (e.g. `feat_2026-08-22_export-csv`).
- `spanId` = one turn/invocation of an agent.
- `parentSpanId` = who invoked it (the Director, or the parent agent for subagents) — this gives natural nesting for subagents.

Storage: a `logs/<featureId>.jsonl` file, one event per line, append-only. Simple, readable, git-versionable. If finer queries are needed later (e.g. "how long did QA take on average"), index to SQLite without changing the event schema.

Event schema:

```json
{
  "timestamp": "2026-08-22T14:03:11Z",
  "traceId": "feat_2026-08-22_export-csv",
  "spanId": "agt_dev_003",
  "parentSpanId": "agt_director_001",
  "agentRole": "Dev",
  "event": "tool_call",
  "tool": "mcp:git.commit",
  "input": { "message": "feat: add CSV export endpoint" },
  "output": { "sha": "a1b2c3d" },
  "tokensUsed": 1532
}
```

Filtering by `traceId` answers "what happened in this feature?" and filtering by `agentRole` answers "what did QA say everywhere?". Combining both: "what did QA say in this feature?".

## 4. Persistent memory and resuming in-progress features

Modeled as a state machine per feature, independent of logs (logs are immutable history; state is the current snapshot).

File: `features/<featureId>/state.json`.

```json
{
  "featureId": "feat_2026-08-22_export-csv",
  "title": "Export reports to CSV",
  "status": "in_progress",
  "currentStage": "QA",
  "stages": {
    "PM": { "status": "done", "artifact": "specs.md" },
    "Architect": { "status": "done", "artifact": "design.md" },
    "Dev": { "status": "done", "artifact": "branch:feature/export-csv" },
    "QA": { "status": "failed", "artifact": "qa-report.md", "notes": "2 tests failing" },
    "DevOps": { "status": "pending" }
  },
  "updatedAt": "2026-08-22T15:10:00Z"
}
```

Resume flow: the user says "resume export-csv". The Director queries the state, sees `currentStage: QA` with `status: failed`, loads only what is needed (the branch diff and the QA report), and re-invokes the Dev agent with that focused context — without rerunning PM or Architect from scratch.

Design decision: rather than treating this as "a separate database", it is exposed as one more MCP server — **Feature State MCP** — with tools like `get_feature_state`, `update_feature_state`, and `list_pending_features`. Agents consult it as an MCP client, the same way they consult git or the test runner. This reinforces the same MCP pattern instead of adding a distinct infrastructure piece, and it also solves cross-session persistent memory: any process that starts fresh can reconstruct where each feature left off just by talking to that server.

## 5. Proposed folder structure

```
ai-dev-studio/
  packages/
    core/                # TS SDK wrapper, Messages API calls, streaming
    agents/
      director/
      pm/
      architect/
      dev/
      qa/
      devops/
    mcp-servers/
      filesystem-git/
      ticketing/
      test-runner/
      notifications/
      feature-state/     # the "Feature State MCP" from section 4
    chat/                # interface (web or bot) consuming Messaging API with streaming
  features/
    <featureId>/
      state.json
      specs.md
      design.md
      qa-report.md
  logs/
    <featureId>.jsonl
  ARCHITECTURE.md
```

## 6. Phase roadmap

1. **Phase 0 — Foundations**: TS project, minimal SDK wrapper, a single Messages API call (no agents yet).
2. **Phase 1 — First MCP server + client**: build the `feature-state` MCP and a minimal client that reads/writes state. End-to-end MCP client/server pair tested here.
3. **Phase 2 — One end-to-end agent**: a single Dev agent that receives a simple task, uses a filesystem/git MCP, and completes it. No multi-agent yet.
4. **Phase 3 — Multi-agent pipeline**: add PM → Architect → Dev → QA → DevOps orchestrated by the Director, in sequence.
5. **Phase 4 — SubAgents**: inside Dev, split a large task into subagents per file/module.
6. **Phase 5 — Chat with streaming**: interface (web or bot) showing progress in real time via Messaging API.
7. **Phase 6 — Robust logging and resume**: complete traces per feature/agent, and a real "resume feature X" flow after an interruption.


### Current Source Tree (Phases 0–1)

```
src/
├── core/client.ts               # Singleton Anthropic client; sendMessage() + streamMessage()
├── feature-state/store.ts       # Pure disk-based state logic; no network deps
└── mcp-servers/feature-state/
    └── server.ts                # MCP server wrapping store as three tools
```

### Layer Responsibilities

**`src/core/client.ts`** — Thin wrapper around `@anthropic-ai/sdk`. Lazy-initializes one `Anthropic` instance. Exports `sendMessage()` (blocking) and `streamMessage()` (callback per chunk). No tool use, no agent logic.

**`src/feature-state/store.ts`** — Pure state management with zero external dependencies. Reads/writes `features/<featureId>/state.json`. Key method: `upsertState()` does a shallow merge so updating one pipeline stage never clobbers others. `listPending()` returns all features not yet "done".

**`src/mcp-servers/feature-state/server.ts`** — Exposes `FeatureStateStore` via stdio MCP transport. Three tools: `get_feature_state`, `update_feature_state`, `list_pending_features`. Agents will consume this as an MCP client — it is the uniform state integration point, not a separate DB.

### Runtime Data

- `features/<featureId>/state.json` — Feature state (gitignored except `.gitkeep`)
- `logs/<featureId>.jsonl` — Append-only OpenTelemetry-style traces (gitignored except `.gitkeep`)

## 7. Open questions for the next design session

- Is the chat interface a web app, a Telegram/Slack bot, or a CLI for the first version?
- Are the ticketing/notifications MCP servers local mocks or connected to real tools from the start?
- Does each feature live on its own real git branch, or in a separate practice repo?
