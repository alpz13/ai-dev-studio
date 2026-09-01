/**
 * End-to-end test for the Feature State MCP: spawns the server as a
 * subprocess (stdio), connects as an MCP client, and exercises the
 * three tools. Requires `npm install` first.
 *
 * Usage: npm run test:mcp-client
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp-servers/feature-state/server.ts"],
  });

  const client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(
    "Available tools:",
    tools.tools.map((t) => t.name),
  );

  const created = await client.callTool({
    name: "update_feature_state",
    arguments: {
      featureId: "feat_demo_export-csv",
      title: "Export reports to CSV",
      status: "in_progress",
      currentStage: "Dev",
      stages: {
        PM: { status: "done", artifact: "specs.md" },
        Architect: { status: "done", artifact: "design.md" },
        Dev: { status: "in_progress" },
      },
    },
  });
  console.log("\nState created/updated:\n", (created.content as Array<{ text: string }>)[0].text);

  const fetched = await client.callTool({
    name: "get_feature_state",
    arguments: { featureId: "feat_demo_export-csv" },
  });
  console.log("\nState read back:\n", (fetched.content as Array<{ text: string }>)[0].text);

  const pending = await client.callTool({ name: "list_pending_features", arguments: {} });
  console.log("\nPending features:\n", (pending.content as Array<{ text: string }>)[0].text);

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
