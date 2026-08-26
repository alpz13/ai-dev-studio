/**
 * Connects as an MCP client to the filesystem-git server, launching it as
 * a subprocess pointed at a specific workspace. Extracted from the Dev
 * agent (Phase 2) so that any agent that needs this same MCP (PM,
 * Architect, Dev, QA, DevOps) can reuse it — see filesystem-agent.ts.
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
