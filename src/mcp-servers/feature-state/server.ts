#!/usr/bin/env node
/**
 * Feature State MCP Server.
 *
 * Exposes each feature's state (what stage it's at, what's done, what's
 * left) as MCP tools, so any agent (the Director, or another) can
 * read/update it as an MCP client instead of touching files directly.
 * See ARCHITECTURE.md section 4.
 *
 * Usage: tsx src/mcp-servers/feature-state/server.ts
 * (normally not run by hand: an MCP client launches it as a subprocess
 * over stdio, see scripts/test-feature-state-client.ts)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FeatureStateStore, type StageName, type FeatureStatus, type StageInfo } from "../../feature-state/store.js";

const store = new FeatureStateStore();

const server = new Server(
  { name: "feature-state-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_feature_state",
      description: "Gets the current state of a feature by its featureId. Returns null if it doesn't exist.",
      inputSchema: {
        type: "object",
        properties: {
          featureId: { type: "string", description: "Unique feature id, e.g. feat_2026-08-22_export-csv" },
        },
        required: ["featureId"],
      },
    },
    {
      name: "update_feature_state",
      description:
        "Creates the feature if it doesn't exist, or updates (shallow merge) its title, status, currentStage and/or stages. Use it whenever an agent finishes or fails its part, so it can be resumed later.",
      inputSchema: {
        type: "object",
        properties: {
          featureId: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "blocked", "done"] },
          currentStage: { type: "string", enum: ["PM", "Architect", "Dev", "QA", "DevOps"] },
          stages: {
            type: "object",
            description:
              "Partial map by stage, e.g. { \"QA\": { \"status\": \"failed\", \"notes\": \"2 tests failing\" } }",
          },
          qaRetries: {
            type: "number",
            description:
              "How many times QA has already sent this feature back to Dev. Persisted so a crash-and-resume mid QA-retry-cycle doesn't lose the count.",
          },
        },
        required: ["featureId"],
      },
    },
    {
      name: "list_pending_features",
      description: "Lists the features whose status is not 'done' — useful for knowing what can be resumed.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  // Everything wrapped in try/catch (same as filesystem-git/server.ts): so
  // an unknown tool or an internal error responds with isError:true instead
  // of dropping the whole MCP connection.
  try {
    switch (name) {
      case "get_feature_state": {
        const featureId = String(args.featureId);
        const state = await store.readState(featureId);
        return ok(state ? JSON.stringify(state, null, 2) : `No state exists for "${featureId}".`);
      }

      case "update_feature_state": {
        const updated = await store.upsertState({
          featureId: String(args.featureId),
          title: args.title as string | undefined,
          status: args.status as FeatureStatus | undefined,
          currentStage: args.currentStage as StageName | undefined,
          stages: args.stages as Partial<Record<StageName, StageInfo>> | undefined,
          qaRetries: args.qaRetries as number | undefined,
        });
        return ok(JSON.stringify(updated, null, 2));
      }

      case "list_pending_features": {
        const pending = await store.listPending();
        return ok(JSON.stringify(pending, null, 2));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
});

async function main() {
  await store.ensureDir();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[feature-state-mcp] ready, listening on stdio");
}

main().catch((err) => {
  console.error("[feature-state-mcp] fatal error:", err);
  process.exit(1);
});
