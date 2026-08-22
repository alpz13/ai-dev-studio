# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AI Dev Studio** simulates a software development team made of specialized AI agents (PM, Architect, Dev, QA, DevOps) orchestrated by a Director agent. A user describes a feature in natural language; the pipeline produces specs → technical design → code → tests → PR, with real-time progress visible in a chat interface.

The project is an intentional practice environment for the full Anthropic stack: TypeScript SDK, Messages API, MCP, agents, multi-agent orchestration, and subagents. It follows a 7-phase roadmap — **Phases 0 and 1 are complete**; no agent or multi-agent logic exists yet.

See `ARCHITECTURE.md` for the full design, stack mapping, logging schema, and 7-phase roadmap.

## Commands

```bash
# Type checking (primary quality gate — no linter configured)
npm run typecheck

# Smoke test: FeatureStateStore logic (no network, no MCP required)
npm run test:store

# E2E test: launches MCP server as subprocess, exercises all three tools
npm run test:mcp-client

# Integration test: Messages API wrapper (requires ANTHROPIC_API_KEY in .env)
npm run test:core

# Run the Feature State MCP server directly (stdio transport)
npm run mcp:feature-state
```

No build step is needed — `tsx` runs TypeScript directly. To emit compiled output: `npx tsc` → `./dist/`.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md)

## Key Conventions

- **Language**: All code comments, error messages, and documentation are in Spanish.
- **ESM**: `"type": "module"` + `"moduleResolution": "NodeNext"` — use `.js` extensions in imports even for `.ts` source files.
- **No build step in dev**: `tsx` handles JIT transpilation; the `dist/` output is only for deployment.
- **State-as-MCP pattern**: Feature state is accessed exclusively through the MCP server, not by reading disk directly from agents. This keeps MCP as the uniform integration layer.
- **Tracing model**: Each feature = one `traceId`; each agent invocation = one `spanId` with a `parentSpanId` pointing to its caller (Director or parent subagent).

## Environment Setup

```bash
npm install
cp .env.example .env   # then add ANTHROPIC_API_KEY
```

`ANTHROPIC_MODEL` defaults to `claude-sonnet-4-5-20250929` if omitted.
