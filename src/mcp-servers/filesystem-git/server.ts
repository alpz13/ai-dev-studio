#!/usr/bin/env node
/**
 * Filesystem + Git MCP Server.
 *
 * Gives an agent (typically Dev) a scoped file workspace versioned with
 * git, exposed as MCP tools: list_dir, read_file, write_file, git_status,
 * git_add, git_commit, git_diff.
 *
 * The workspace root is set via WORKSPACE_ROOT (env var); if it doesn't
 * exist yet or isn't a git repo yet, it's created/initialized on startup.
 *
 * Usage: tsx src/mcp-servers/filesystem-git/server.ts
 * (normally launched by an MCP client as a subprocess over stdio, see
 * src/agents/dev/agent.ts)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensureRoot, listDirEntries, readTextFile, writeTextFile } from "../../filesystem-git/fs-ops.js";
import { gitAdd, gitCommit, gitDiff, gitInitIfNeeded, gitStatus } from "../../filesystem-git/git-ops.js";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "workspaces/default";

const server = new Server(
  { name: "filesystem-git-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_dir",
      description: "Lists files and folders inside the workspace, relative to its root.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path, default '.'" } },
      },
    },
    {
      name: "read_file",
      description: "Reads the contents of a text file inside the workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description:
        "Writes (creates or overwrites) a text file inside the workspace, creating intermediate folders if needed.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "git_status",
      description: "Git status in porcelain format (what's dirty or staged).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "git_add",
      description: "Adds files to the git staging area.",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "default ['.']" },
        },
      },
    },
    {
      name: "git_commit",
      description: "Creates a commit with what's currently staged. Fails if nothing is staged.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    {
      name: "git_diff",
      description: "Diff of the changes (working tree vs HEAD; with staged=true, staging area vs HEAD).",
      inputSchema: {
        type: "object",
        properties: { staged: { type: "boolean" } },
      },
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

  try {
    switch (name) {
      case "list_dir": {
        const entries = await listDirEntries(WORKSPACE_ROOT, (args.path as string | undefined) ?? ".");
        return ok(JSON.stringify(entries, null, 2));
      }
      case "read_file":
        return ok(await readTextFile(WORKSPACE_ROOT, String(args.path)));
      case "write_file":
        await writeTextFile(WORKSPACE_ROOT, String(args.path), String(args.content));
        return ok(`Written: ${args.path}`);
      case "git_status":
        return ok((await gitStatus(WORKSPACE_ROOT)) || "(no pending changes)");
      case "git_add":
        await gitAdd(WORKSPACE_ROOT, (args.paths as string[] | undefined) ?? ["."]);
        return ok("Files added to staging.");
      case "git_commit":
        return ok(`Commit created: ${await gitCommit(WORKSPACE_ROOT, String(args.message))}`);
      case "git_diff":
        return ok((await gitDiff(WORKSPACE_ROOT, { staged: Boolean(args.staged) })) || "(no differences)");
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err);
  }
});

async function main() {
  await ensureRoot(WORKSPACE_ROOT);
  await gitInitIfNeeded(WORKSPACE_ROOT);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[filesystem-git-mcp] ready, workspace: ${WORKSPACE_ROOT}`);
}

main().catch((err) => {
  console.error("[filesystem-git-mcp] fatal error:", err);
  process.exit(1);
});
