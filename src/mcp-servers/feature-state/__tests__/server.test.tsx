import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// server.ts runs `main()` as soon as it's imported (it has no "only if this
// is the entrypoint" guard), so to test its tool routing without spinning up
// a real stdio process, we mock the MCP SDK and capture the handlers the
// server registers with setRequestHandler. The business logic behind it
// (FeatureStateStore) is NOT mocked: it runs for real against a temporary
// FEATURES_DIR, so this is more of an integration test of the wiring than a
// pure unit test — deliberately, since that's the part easiest to break by
// accident.
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
  StdioServerTransport: vi.fn().mockImplementation(function () { return {}; }),
}));

async function loadServerModule(featuresDir: string) {
  handlers = new Map();
  process.env.FEATURES_DIR = featuresDir;
  vi.resetModules();
  await import("../../../mcp-servers/feature-state/server.js");
  // main() keeps running in the background after the import (ensureDir +
  // connect, both harmless/mocked here); one tick is enough for it to
  // finish before the test continues.
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

  it("registers list_tools and exposes the three expected tools", async () => {
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

  it("get_feature_state on a nonexistent feature responds with a message, not an error", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({
      params: { name: "get_feature_state", arguments: { featureId: "feat_no_existe" } },
    });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/No state exists/);
  });

  it("update_feature_state creates the feature and get_feature_state then returns it", async () => {
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

  it("update_feature_state shallow-merges stages across successive calls", async () => {
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

  it("list_pending_features excludes features with status done", async () => {
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

  it("an unknown tool responds isError: true instead of dropping the connection", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({ params: { name: "no_existe", arguments: {} } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Unknown tool/);
  });
});
