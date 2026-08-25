#!/usr/bin/env node
/**
 * Filesystem + Git MCP Server.
 *
 * Le da a un agente (típicamente Dev) un workspace de archivos acotado y
 * versionado con git, expuesto como herramientas MCP: list_dir, read_file,
 * write_file, git_status, git_add, git_commit, git_diff.
 *
 * La raíz del workspace se fija por WORKSPACE_ROOT (env var); si no existe
 * o no es un repo de git todavía, se crea/inicializa solo al arrancar.
 *
 * Uso: tsx src/mcp-servers/filesystem-git/server.ts
 * (normalmente lo lanza un cliente MCP como subproceso por stdio, ver
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
      description: "Lista archivos y carpetas dentro del workspace, relativo a su raíz.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Ruta relativa, default '.'" } },
      },
    },
    {
      name: "read_file",
      description: "Lee el contenido de un archivo de texto dentro del workspace.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description:
        "Escribe (crea o sobreescribe) un archivo de texto dentro del workspace, creando carpetas intermedias si hace falta.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "git_status",
      description: "Estado de git en formato porcelain (qué está sucio o en staging).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "git_add",
      description: "Agrega archivos al staging area de git.",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "default ['.']" },
        },
      },
    },
    {
      name: "git_commit",
      description: "Crea un commit con lo que esté en staging. Falla si no hay nada staged.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    {
      name: "git_diff",
      description: "Diff de los cambios (working tree vs HEAD; con staged=true, del staging area vs HEAD).",
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
        return ok(`Escrito: ${args.path}`);
      case "git_status":
        return ok((await gitStatus(WORKSPACE_ROOT)) || "(sin cambios pendientes)");
      case "git_add":
        await gitAdd(WORKSPACE_ROOT, (args.paths as string[] | undefined) ?? ["."]);
        return ok("Archivos agregados al staging.");
      case "git_commit":
        return ok(`Commit creado: ${await gitCommit(WORKSPACE_ROOT, String(args.message))}`);
      case "git_diff":
        return ok((await gitDiff(WORKSPACE_ROOT, { staged: Boolean(args.staged) })) || "(sin diferencias)");
      default:
        throw new Error(`Herramienta desconocida: ${name}`);
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
  console.error(`[filesystem-git-mcp] listo, workspace: ${WORKSPACE_ROOT}`);
}

main().catch((err) => {
  console.error("[filesystem-git-mcp] error fatal:", err);
  process.exit(1);
});
