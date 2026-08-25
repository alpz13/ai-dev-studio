#!/usr/bin/env node
/**
 * Feature State MCP Server.
 *
 * Expone el estado de cada feature (en qué stage va, qué se hizo, qué falta)
 * como herramientas MCP, para que cualquier agente (el Director, u otro)
 * pueda leerlo/actualizarlo como cliente MCP en lugar de tocar archivos
 * directamente. Ver ARCHITECTURE.md sección 4.
 *
 * Uso: tsx src/mcp-servers/feature-state/server.ts
 * (normalmente no se corre a mano: un cliente MCP lo lanza como subproceso
 * por stdio, ver scripts/test-feature-state-client.ts)
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
      description: "Obtiene el estado actual de una feature por su featureId. Devuelve null si no existe.",
      inputSchema: {
        type: "object",
        properties: {
          featureId: { type: "string", description: "Id único de la feature, ej. feat_2026-08-22_export-csv" },
        },
        required: ["featureId"],
      },
    },
    {
      name: "update_feature_state",
      description:
        "Crea la feature si no existe, o actualiza (merge superficial) su título, status, currentStage y/o stages. Úsalo cada vez que un agente termina o falla su parte, para poder retomar después.",
      inputSchema: {
        type: "object",
        properties: {
          featureId: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "blocked", "done"] },
          currentStage: { type: "string", enum: ["PM", "Arquitecto", "Dev", "QA", "DevOps"] },
          stages: {
            type: "object",
            description:
              "Mapa parcial por stage, ej. { \"QA\": { \"status\": \"failed\", \"notes\": \"2 tests failing\" } }",
          },
        },
        required: ["featureId"],
      },
    },
    {
      name: "list_pending_features",
      description: "Lista las features cuyo status no es 'done' — útil para saber qué se puede retomar.",
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

  // Todo envuelto en try/catch (igual que filesystem-git/server.ts): que una
  // tool desconocida o un error interno responda isError:true en vez de
  // tirar la conexión MCP entera.
  try {
    switch (name) {
      case "get_feature_state": {
        const featureId = String(args.featureId);
        const state = await store.readState(featureId);
        return ok(state ? JSON.stringify(state, null, 2) : `No existe estado para "${featureId}".`);
      }

      case "update_feature_state": {
        const updated = await store.upsertState({
          featureId: String(args.featureId),
          title: args.title as string | undefined,
          status: args.status as FeatureStatus | undefined,
          currentStage: args.currentStage as StageName | undefined,
          stages: args.stages as Partial<Record<StageName, StageInfo>> | undefined,
        });
        return ok(JSON.stringify(updated, null, 2));
      }

      case "list_pending_features": {
        const pending = await store.listPending();
        return ok(JSON.stringify(pending, null, 2));
      }

      default:
        throw new Error(`Herramienta desconocida: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
});

async function main() {
  await store.ensureDir();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[feature-state-mcp] listo, escuchando por stdio");
}

main().catch((err) => {
  console.error("[feature-state-mcp] error fatal:", err);
  process.exit(1);
});
