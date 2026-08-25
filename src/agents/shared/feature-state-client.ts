/**
 * Cliente MCP hacia el Feature State MCP (ver src/mcp-servers/feature-state/server.ts),
 * usado por el Director para leer y actualizar en qué stage va cada
 * feature — ver ARCHITECTURE.md sección 4. `connectFeatureStateClient`
 * necesita el SDK real (se mockea en pruebas); las otras tres funciones
 * solo dependen de la forma mínima de un "cliente" con `callTool`, así que
 * se pueden probar con un objeto falso simple, sin mockear módulos.
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
  if (result.isError || text.startsWith("No existe estado")) return null;
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
    throw new Error(`update_feature_state falló: ${textOf(result)}`);
  }
  return JSON.parse(textOf(result)) as FeatureState;
}

export async function listPendingFeatures(client: FeatureStateToolsClient): Promise<FeatureState[]> {
  const result = await client.callTool({ name: "list_pending_features", arguments: {} });
  if (result.isError) {
    throw new Error(`list_pending_features falló: ${textOf(result)}`);
  }
  return JSON.parse(textOf(result)) as FeatureState[];
}
