/**
 * Conecta como cliente MCP al servidor filesystem-git, lanzándolo como
 * subproceso apuntado a un workspace específico. Extraído del agente Dev
 * (Fase 2) para que cualquier agente que necesite ese mismo MCP (PM,
 * Arquitecto, Dev, QA, DevOps) lo reutilice — ver filesystem-agent.ts.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function connectFilesystemGitClient(workspaceRoot: string, clientName = "filesystem-git-client") {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp-servers/filesystem-git/server.ts"],
    env: { ...process.env, WORKSPACE_ROOT: workspaceRoot } as Record<string, string>,
  });
  const client = new Client({ name: clientName, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
