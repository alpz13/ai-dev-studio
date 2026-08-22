#!/usr/bin/env node
/**
 * Feature State MCP Server.
 *
 * Exposes each feature's state (current stage, what's done, what's pending)
 * as MCP tools, so any agent (the Director, or another) can read/update it
 * as an MCP client instead of touching files directly. See ARCHITECTURE.md section 4.
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
      description: "Gets the current state of a feature by its featureId. Returns null if it does not exist.",
      inputSchema: {
        type: "object",
        properties: {
          featureId: { type: "string", description: "Unique feature ID, e.g. feat_2026-08-22_export-csv" },
        },
        required: ["featureId"],
      },
    },
    {
      name: "update_feature_state",
      description:
        "Creates the feature if it does not exist, or updates (shallow merge) its title, status, currentStage and/or stages. Call this whenever an agent completes or fails its part, so the feature can be resumed later.",
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
        },
        required: ["featureId"],
      },
    },
    {
      name: "list_pending_features",
      description: "Lists features whose status is not 'done' — useful for finding what can be resumed.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  switch (name) {
    case "get_feature_state": {
      const featureId = String(args.featureId);
      const state = await store.readState(featureId);
      return {
        content: [
          {
            type: "text" as const,
            text: state ? JSON.stringify(state, null, 2) : `No state found for "${featureId}".`,
          },
        ],
      };
    }

    case "update_feature_state": {
      const updated = await store.upsertState({
        featureId: String(args.featureId),
        title: args.title as string | undefined,
        status: args.status as FeatureStatus | undefined,
        currentStage: args.currentStage as StageName | undefined,
        stages: args.stages as Partial<Record<StageName, StageInfo>> | undefined,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }] };
    }

    case "list_pending_features": {
      const pending = await store.listPending();
      return { content: [{ type: "text" as const, text: JSON.stringify(pending, null, 2) }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
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
