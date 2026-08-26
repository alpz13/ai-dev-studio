/**
 * MCP client for the Feature State MCP (see src/mcp-servers/feature-state/server.ts),
 * used by the Director to read and update which stage each feature is at
 * — see ARCHITECTURE.md section 4. `connectFeatureStateClient` needs the
 * real SDK (mocked in tests); the other three functions only depend on
 * the minimal shape of a "client" with `callTool`, so they can be tested
 * with a simple fake object, without mocking any modules.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { FeatureState, UpdateFeatureStateInput } from "../../feature-state/store.js";

export interface FeatureStateToolsClient {
  callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<{
    content: Array<{ text?: string }>;
    isError?: boolean;
  }>;
}

export async function connectFeatureStateClient(clientName = "feature-state-client"): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp-servers/feature-state/server.ts"],
  });
  const client = new Client({ name: clientName, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

export async function getFeatureState(client: FeatureStateToolsClient, featureId: string): Promise<FeatureState | null> {
  const result = await client.callTool({ name: "get_feature_state", arguments: { featureId } });
  const text = textOf(result);
  if (result.isError || text.startsWith("No state exists")) return null;
  return JSON.parse(text) as FeatureState;
}

export async function updateFeatureState(
  client: FeatureStateToolsClient,
  input: UpdateFeatureStateInput,
): Promise<FeatureState> {
  const result = await client.callTool({
    name: "update_feature_state",
    arguments: input as unknown as Record<string, unknown>,
  });
  if (result.isError) {
    throw new Error(`update_feature_state failed: ${textOf(result)}`);
  }
  return JSON.parse(textOf(result)) as FeatureState;
}

export async function listPendingFeatures(client: FeatureStateToolsClient): Promise<FeatureState[]> {
  const result = await client.callTool({ name: "list_pending_features", arguments: {} });
  if (result.isError) {
    throw new Error(`list_pending_features failed: ${textOf(result)}`);
  }
  return JSON.parse(textOf(result)) as FeatureState[];
}
