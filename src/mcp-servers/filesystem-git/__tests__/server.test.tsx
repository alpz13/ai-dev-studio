import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same approach as __test__/mcp-servers/feature-state/server.test.tsx: the
// MCP SDK is mocked and the registered handlers are captured; fs-ops and
// git-ops (with real git) run unmocked, against a temporary WORKSPACE_ROOT.
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

async function loadServerModule(workspaceRoot: string) {
  handlers = new Map();
  process.env.WORKSPACE_ROOT = workspaceRoot;
  vi.resetModules();
  // gitInitIfNeeded spawns real child processes — we need to wait until
  // main() finishes, not just one tick. connectMock is the last thing main()
  // awaits, so resolving when it's called guarantees ensureRoot +
  // gitInitIfNeeded are both done before any test assertion runs.
  const ready = new Promise<void>((resolve) => {
    connectMock.mockImplementationOnce(async () => { resolve(); });
  });
  await import("../../../mcp-servers/filesystem-git/server.js");
  await ready;
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

  it("leaves the workspace initialized as a git repo on startup", async () => {
    const stat = await fs.stat(path.join(workspaceRoot, ".git"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("registers list_tools with the seven expected tools", async () => {
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

  it("write_file + read_file + list_dir work end to end", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    await callToolHandler({ params: { name: "write_file", arguments: { path: "hello.txt", content: "hello\n" } } });

    const readResult = await callToolHandler({ params: { name: "read_file", arguments: { path: "hello.txt" } } });
    expect(textOf(readResult)).toBe("hello\n");

    const listResult = await callToolHandler({ params: { name: "list_dir", arguments: {} } });
    const entries = JSON.parse(textOf(listResult)) as Array<{ name: string; type: string }>;
    expect(entries).toContainEqual({ name: "hello.txt", type: "file" });
  });

  it("write_file outside the workspace responds isError: true instead of dropping the connection", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({
      params: { name: "write_file", arguments: { path: "../outside.txt", content: "x" } },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/outside the allowed workspace/);
  });

  it("git_status → git_add → git_commit → git_status ends up clean", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    await callToolHandler({ params: { name: "write_file", arguments: { path: "hello.txt", content: "hello\n" } } });

    const statusBefore = await callToolHandler({ params: { name: "git_status", arguments: {} } });
    expect(textOf(statusBefore)).toMatch(/hello\.txt/);

    await callToolHandler({ params: { name: "git_add", arguments: { paths: ["."] } } });
    const commitResult = await callToolHandler({
      params: { name: "git_commit", arguments: { message: "feat: hello" } },
    });
    expect(textOf(commitResult)).toMatch(/Commit created/);

    const statusAfter = await callToolHandler({ params: { name: "git_status", arguments: {} } });
    expect(textOf(statusAfter)).toBe("(no pending changes)");
  });

  it("git_commit with nothing staged responds isError: true with git's message", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({
      params: { name: "git_commit", arguments: { message: "nothing to commit" } },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/failed/);
  });

  it("git_diff reflects changes made after a commit", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    await callToolHandler({ params: { name: "write_file", arguments: { path: "hello.txt", content: "v1\n" } } });
    await callToolHandler({ params: { name: "git_add", arguments: {} } });
    await callToolHandler({ params: { name: "git_commit", arguments: { message: "v1" } } });

    await callToolHandler({ params: { name: "write_file", arguments: { path: "hello.txt", content: "v2\n" } } });
    const diffResult = await callToolHandler({ params: { name: "git_diff", arguments: {} } });

    expect(textOf(diffResult)).toMatch(/v2/);
  });

  it("an unknown tool responds isError: true instead of dropping the connection", async () => {
    const callToolHandler = handlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callToolHandler({ params: { name: "no_existe", arguments: {} } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Unknown tool/);
  });
});
