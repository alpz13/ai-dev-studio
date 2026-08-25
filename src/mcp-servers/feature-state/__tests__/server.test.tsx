import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// server.ts corre `main()` apenas se importa (no tiene guard de "solo si es
// el entrypoint"), así que para probar el ruteo de sus herramientas sin
// levantar un proceso stdio real, mockeamos el SDK de MCP y capturamos los
// handlers que el server registra con setRequestHandler. La lógica de
// negocio detrás (FeatureStateStore) NO se mockea: corre de verdad contra
// un FEATURES_DIR temporal, así que esto es más una prueba de integración
// del wiring que una unitaria pura — a propósito, es la parte más fácil de
// romper por accidente.
const LIST_TOOLS_SCHEMA = Symbol("ListToolsRequestSchema");
const CALL_TOOL_SCHEMA = Symbol("CallToolRequestSchema");

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: LIST_TOOLS_SCHEMA,
  CallToolRequestSchema: CALL_TOOL_SCHEMA,
}));

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type Handler = (request: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<ToolResult>;

let handlers: Map<unknown, Handler>;
const connectMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn().mockImplementation(function () {
    return {
      setRequestHandler: (schema: unknown, handler: Handler) => {
        handlers.set(schema, handler);
      },
      connect: connectMock,
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

async function loadServerModule(featuresDir: string) {
  handlers = new Map();
  process.env.FEATURES_DIR = featuresDir;
  vi.resetModules();
  await import("../../../mcp-servers/feature-state/server.js");
  // main() sigue corriendo en segundo plano tras el import (ensureDir +
  // connect, ambos inofensivos/mockeados aquí); un tick alcanza para que
  // termine antes de que el test siga.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function textOf(result: ToolResult): string {
  return result.content[0].text;
}

describe("mcp-servers/feature-state/server", () => {
  let featuresDir: string;

  beforeEach(async () => {
    featuresDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-fstate-server-test-"));
    connectMock.mockClear();
    await loadServerModule(featuresDir);
  });

  afterEach(async () => {
    await fs.rm(featuresDir, { recursive: true, force: true });
    delete process.env.FEATURES_DIR;
  });

  it("registra list_tools y expone las tres herramientas esperadas", async () => {
    const listToolsHandler = handlers.get(LIST_TOOLS_SCHEMA);
    expect(listToolsHandler).toBeDefined();

    const result = (await listToolsHandler!({ params: { name: "" } })) as unknown as {
      tools: Array<{ name: string }>;
    };

    expect(result.tools.map((t) => t.name)).toEqual([
      "get_feature_state",
      "update_feature_state",
      "list_pending_features",
    ]);
  });

  it("get_feature_state sobre una feature inexistente responde con un mensaje, no un error", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({
      params: { name: "get_feature_state", arguments: { featureId: "feat_no_existe" } },
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/No existe estado/);
  });

  it("update_feature_state crea la feature y luego get_feature_state la devuelve", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const updateResult = await callToolHandler({
      params: {
        name: "update_feature_state",
        arguments: { featureId: "feat_demo", title: "Demo", status: "in_progress", currentStage: "Dev" },
      },
    });
    expect(textOf(updateResult)).toMatch(/"featureId": "feat_demo"/);

    const getResult = await callToolHandler({
      params: { name: "get_feature_state", arguments: { featureId: "feat_demo" } },
    });
    expect(textOf(getResult)).toMatch(/"status": "in_progress"/);
  });

  it("update_feature_state hace merge superficial de stages en llamadas sucesivas", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    await callToolHandler({
      params: {
        name: "update_feature_state",
        arguments: { featureId: "feat_demo", stages: { PM: { status: "done" } } },
      },
    });
    const result = await callToolHandler({
      params: {
        name: "update_feature_state",
        arguments: { featureId: "feat_demo", stages: { Dev: { status: "in_progress" } } },
      },
    });

    const parsed = JSON.parse(textOf(result));
    expect(parsed.stages.PM.status).toBe("done");
    expect(parsed.stages.Dev.status).toBe("in_progress");
  });

  it("list_pending_features excluye las features con status done", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    await callToolHandler({
      params: { name: "update_feature_state", arguments: { featureId: "feat_activa", status: "in_progress" } },
    });
    await callToolHandler({
      params: { name: "update_feature_state", arguments: { featureId: "feat_lista", status: "done" } },
    });

    const result = await callToolHandler({ params: { name: "list_pending_features", arguments: {} } });
    const pending = JSON.parse(textOf(result)) as Array<{ featureId: string }>;

    expect(pending.map((f) => f.featureId)).toEqual(["feat_activa"]);
  });

  it("una herramienta desconocida responde isError: true en vez de tirar la conexión", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({ params: { name: "no_existe", arguments: {} } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Herramienta desconocida/);
  });
});
