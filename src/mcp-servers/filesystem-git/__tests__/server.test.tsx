import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mismo enfoque que __test__/mcp-servers/feature-state/server.test.tsx: se
// mockea el SDK de MCP y se capturan los handlers registrados; fs-ops y
// git-ops (con git real) corren sin mockear, contra un WORKSPACE_ROOT
// temporal.
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

async function loadServerModule(workspaceRoot: string) {
  handlers = new Map();
  process.env.WORKSPACE_ROOT = workspaceRoot;
  vi.resetModules();
  connectMock.mockClear();
  await import("../server.js");
  // gitInitIfNeeded (async) corre antes de connect: esperar a que connectMock
  // sea invocado garantiza que git init terminó antes de que el test empiece.
  await vi.waitUntil(() => connectMock.mock.calls.length > 0, { timeout: 10_000, interval: 20 });
}

function textOf(result: ToolResult): string {
  return result.content[0].text;
}

describe("mcp-servers/filesystem-git/server", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-studio-fsgit-server-test-"));
    connectMock.mockClear();
    await loadServerModule(workspaceRoot);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    delete process.env.WORKSPACE_ROOT;
  });

  it("al arrancar deja el workspace inicializado como repo de git", async () => {
    const stat = await fs.stat(path.join(workspaceRoot, ".git"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("registra list_tools con las siete herramientas esperadas", async () => {
    const listToolsHandler = handlers.get(LIST_TOOLS_SCHEMA)!;

    const result = (await listToolsHandler({ params: { name: "" } })) as unknown as {
      tools: Array<{ name: string }>;
    };

    expect(result.tools.map((t) => t.name)).toEqual([
      "list_dir",
      "read_file",
      "write_file",
      "git_status",
      "git_add",
      "git_commit",
      "git_diff",
    ]);
  });

  it("write_file + read_file + list_dir funcionan de punta a punta", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    await callToolHandler({ params: { name: "write_file", arguments: { path: "hello.txt", content: "hola\n" } } });

    const readResult = await callToolHandler({ params: { name: "read_file", arguments: { path: "hello.txt" } } });
    expect(textOf(readResult)).toBe("hola\n");

    const listResult = await callToolHandler({ params: { name: "list_dir", arguments: {} } });
    const entries = JSON.parse(textOf(listResult)) as Array<{ name: string; type: string }>;
    expect(entries).toContainEqual({ name: "hello.txt", type: "file" });
  });

  it("write_file fuera del workspace responde isError: true en vez de tirar la conexión", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({
      params: { name: "write_file", arguments: { path: "../fuera.txt", content: "x" } },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/fuera del workspace/);
  });

  it("git_status → git_add → git_commit → git_status queda limpio", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    await callToolHandler({ params: { name: "write_file", arguments: { path: "hello.txt", content: "hola\n" } } });

    const statusBefore = await callToolHandler({ params: { name: "git_status", arguments: {} } });
    expect(textOf(statusBefore)).toMatch(/hello\.txt/);

    await callToolHandler({ params: { name: "git_add", arguments: { paths: ["."] } } });
    const commitResult = await callToolHandler({
      params: { name: "git_commit", arguments: { message: "feat: hello" } },
    });
    expect(textOf(commitResult)).toMatch(/Commit creado/);

    const statusAfter = await callToolHandler({ params: { name: "git_status", arguments: {} } });
    expect(textOf(statusAfter)).toBe("(sin cambios pendientes)");
  });

  it("git_commit sin nada en staging responde isError: true con el mensaje de git", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({
      params: { name: "git_commit", arguments: { message: "nada que commitear" } },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/falló/);
  });

  it("git_diff refleja cambios hechos después de un commit", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    await callToolHandler({ params: { name: "write_file", arguments: { path: "hello.txt", content: "v1\n" } } });
    await callToolHandler({ params: { name: "git_add", arguments: {} } });
    await callToolHandler({ params: { name: "git_commit", arguments: { message: "v1" } } });

    await callToolHandler({ params: { name: "write_file", arguments: { path: "hello.txt", content: "v2\n" } } });
    const diffResult = await callToolHandler({ params: { name: "git_diff", arguments: {} } });

    expect(textOf(diffResult)).toMatch(/v2/);
  });

  it("una herramienta desconocida responde isError: true en vez de tirar la conexión", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({ params: { name: "no_existe", arguments: {} } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Herramienta desconocida/);
  });
});
