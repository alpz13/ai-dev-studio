#!/usr/bin/env node
/**
 * Director MCP Server.
 *
 * Exposes the whole studio — the PM → Architect → Dev → QA → DevOps
 * pipeline driven by runDirector() — as MCP tools, so an external MCP host
 * (Claude Desktop, Claude Code, another agent) can drive a full feature
 * build the same way `npm run web` already lets a browser do it over
 * HTTP/SSE. See CLAUDE.md's "Director MCP server" design decision for the
 * rationale.
 *
 * `run_feature` returns as soon as the pipeline has *started*, not once it
 * finishes: a full run makes several real Messages API calls across 5
 * agents and can take minutes, which risks an MCP host's tool-call timeout
 * if the call blocked until completion. Progress is polled separately via
 * `get_feature_status`. This also means the pipeline only keeps running as
 * long as this server process stays alive — same lifetime tradeoff
 * `npm run web` already has; state is persisted, so an interrupted run can
 * be resumed later by calling `run_feature` again with just the featureId.
 *
 * No auth: this server is meant to be spawned locally by a trusted MCP host
 * over stdio, the same trust model as the other two internal MCP servers
 * (feature-state, filesystem-git) — unlike the network-facing web server,
 * which requires AUTH_TOKEN.
 *
 * Usage: tsx src/mcp-servers/director/server.ts
 * (normally not run by hand: an MCP host launches it as a subprocess over
 * stdio, see scripts/__tests__/test-director-mcp-client.ts)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startOrResumeFeatureInBackground } from "../../agents/director/run-feature.js";
import { connectFeatureStateClient, getFeatureState, listPendingFeatures, type FeatureStateToolsClient } from "../../agents/shared/feature-state-client.js";
import { TraceLogger } from "../../observability/trace-logger.js";
import { summarizeTrace } from "../../observability/trace-summary.js";

const server = new Server(
  { name: "director-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "run_feature",
      description:
        "Starts a new feature build or resumes an existing one. Returns immediately with the featureId once the pipeline has started — it does not wait for the (potentially multi-minute) pipeline to finish. Poll get_feature_status for progress.",
      inputSchema: {
        type: "object",
        properties: {
          featureId: {
            type: "string",
            description: "Resume this feature. Omit to start a new one (a featureId is generated from task).",
          },
          task: {
            type: "string",
            description: "Natural-language description of the feature. Required when starting a new feature.",
          },
        },
      },
    },
    {
      name: "get_feature_status",
      description:
        "Returns a summary of a feature's pipeline run: stage durations, tokens used, QA retries, and outcome (done/blocked/in_progress/unknown).",
      inputSchema: {
        type: "object",
        properties: {
          featureId: { type: "string" },
        },
        required: ["featureId"],
      },
    },
    {
      name: "get_feature_state",
      description: "Returns the raw stage-by-stage state of a feature by its featureId. Returns null if it doesn't exist.",
      inputSchema: {
        type: "object",
        properties: {
          featureId: { type: "string" },
        },
        required: ["featureId"],
      },
    },
    {
      name: "list_features",
      description: "Lists the features whose status is not 'done' — useful for knowing what's in flight or can be resumed.",
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

  // Everything wrapped in try/catch (same as feature-state/server.ts and
  // filesystem-git/server.ts): an unknown tool or an internal error
  // responds with isError:true instead of dropping the whole connection.
  try {
    switch (name) {
      case "run_feature": {
        const result = await startOrResumeFeatureInBackground({
          featureId: args.featureId as string | undefined,
          task: args.task as string | undefined,
        });
        return ok(JSON.stringify(result));
      }

      case "get_feature_status": {
        const featureId = String(args.featureId);
        const logger = new TraceLogger();
        const events = await logger.readTrace(featureId);
        if (events.length === 0) return ok(`No trace found for "${featureId}".`);
        return ok(JSON.stringify(summarizeTrace(featureId, events), null, 2));
      }

      case "get_feature_state": {
        const featureId = String(args.featureId);
        const client = await connectFeatureStateClient();
        try {
          const state = await getFeatureState(client as unknown as FeatureStateToolsClient, featureId);
          return ok(state ? JSON.stringify(state, null, 2) : `No state exists for "${featureId}".`);
        } finally {
          await client.close();
        }
      }

      case "list_features": {
        const client = await connectFeatureStateClient();
        try {
          const pending = await listPendingFeatures(client as unknown as FeatureStateToolsClient);
          return ok(JSON.stringify(pending, null, 2));
        } finally {
          await client.close();
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[director-mcp] ready, listening on stdio");
}

main().catch((err) => {
  console.error("[director-mcp] fatal error:", err);
  process.exit(1);
});
