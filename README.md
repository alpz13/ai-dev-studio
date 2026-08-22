# AI Dev Studio

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design. This README covers only "how to run what already exists".

## Current status: Phase 0 + Phase 1 of the roadmap

- **Phase 0** — `src/core/client.ts`: minimal wrapper over `@anthropic-ai/sdk` (Messages API), with `sendMessage` and `streamMessage`.
- **Phase 1** — `src/feature-state/store.ts` + `src/mcp-servers/feature-state/server.ts`: the first MCP server ("Feature State MCP" from section 4 of ARCHITECTURE.md), which tracks each feature's current pipeline stage on disk.

No agents, multi-agent, or subagents yet — that begins at Phase 2.

## A note on how this was built

This scaffold was assembled in a cloud sandbox without access to `registry.npmjs.org` (network policy of the environment), so `npm install` could not be run there to validate `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` against the real packages. What was verified end-to-end was the `src/feature-state/store.ts` logic (no external dependencies, see `scripts/test-feature-state-store.ts`). The rest of the code follows the stable, documented shape of both SDKs, but it is worth running the steps below on first setup and reporting any issues — they are quick to fix.

## How to run

```bash
npm install
cp .env.example .env   # then set your ANTHROPIC_API_KEY
```

1. Test the state logic (no network, no API key required):

   ```bash
   npm run test:store
   ```

2. Test the Feature State MCP end-to-end (launches the server as a subprocess and talks to it as an MCP client):

   ```bash
   npm run test:mcp-client
   ```

   You should see the tool list (`get_feature_state`, `update_feature_state`, `list_pending_features`) and the result of creating/reading a sample feature (`feat_demo_export-csv`) at `features/feat_demo_export-csv/state.json`.

3. Test the Messages API wrapper (requires `ANTHROPIC_API_KEY` in `.env`):

   ```bash
   npm run test:core
   ```

4. Type check:

   ```bash
   npm run typecheck
   ```

## Next step (Phase 2)

A single Dev agent that receives a simple task, uses a filesystem/git MCP server, and completes it — no Director or multi-agent pipeline yet.
