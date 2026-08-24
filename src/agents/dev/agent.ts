/**
 * Agente Dev: recibe una tarea en lenguaje natural, y usando la Messages
 * API con tool use corre un loop agentic manual contra el MCP
 * filesystem-git (que lanza como subproceso y le habla como cliente MCP)
 * hasta terminar la tarea. Cada paso queda registrado en logs/<featureId>.jsonl
 * vía TraceLogger — ver ARCHITECTURE.md sección 3.
 *
 * Todavía sin Director ni multi-agente (eso es Fase 3): este agente corre
 * solo, de punta a punta, por su cuenta.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { newSpanId, TraceLogger } from "../../observability/trace-logger.js";
import { mcpToolsToAnthropicTools } from "../shared/mcp-tool-adapter.js";
import { buildToolResultBlock, extractText, extractToolUseBlocks, type ContentBlock } from "../shared/agent-loop-helpers.js";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
const MAX_TURNS = 12;

const DEV_SYSTEM_PROMPT = `Eres el agente Dev de AI Dev Studio. Recibes una tarea de desarrollo puntual
y tienes acceso a un workspace de archivos con control de versiones a través de las
herramientas disponibles (leer/escribir archivos, listar el directorio, y git status/
add/commit/diff). Trabaja de forma incremental: revisa el estado actual antes de
escribir si hace falta, aplica los cambios, y termina siempre confirmándolos con un
commit de git que describa lo que hiciste. Cuando ya hayas terminado, responde con un
resumen breve en texto plano, sin pedir más herramientas.`;

export interface RunDevAgentOptions {
  featureId: string;
  task: string;
  workspaceRoot: string;
}

export async function runDevAgent(opts: RunDevAgentOptions): Promise<string> {
  const traceLogger = new TraceLogger();
  const spanId = newSpanId("agt_dev");
  const traceCtx = { traceId: opts.featureId, spanId, agentRole: "Dev" as const };

  await traceLogger.log({ ...traceCtx, event: "agent_start", input: { task: opts.task, workspaceRoot: opts.workspaceRoot } });

  const anthropic = new Anthropic();
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp-servers/filesystem-git/server.ts"],
    env: { ...process.env, WORKSPACE_ROOT: opts.workspaceRoot } as Record<string, string>,
  });
  const mcpClient = new Client({ name: "dev-agent", version: "0.1.0" }, { capabilities: {} });
  await mcpClient.connect(transport);

  let finalText = "";

  try {
    const { tools: mcpTools } = await mcpClient.listTools();
    const tools = mcpToolsToAnthropicTools(
      mcpTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    );

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.task }];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 2048,
        system: DEV_SYSTEM_PROMPT,
        tools,
        messages,
      });

      const content = response.content as unknown as ContentBlock[];
      messages.push({ role: "assistant", content: response.content });

      const toolUses = extractToolUseBlocks(content);

      if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
        finalText = extractText(content);
        break;
      }

      const resultBlocks = [];
      for (const toolUse of toolUses) {
        await traceLogger.log({ ...traceCtx, event: "tool_call", tool: toolUse.name, input: toolUse.input });
        try {
          const result = await mcpClient.callTool({
            name: toolUse.name,
            arguments: toolUse.input as Record<string, unknown>,
          });
          const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
          await traceLogger.log({
            ...traceCtx,
            event: "tool_result",
            tool: toolUse.name,
            output: text,
            isError: Boolean(result.isError),
          });
          resultBlocks.push(buildToolResultBlock(toolUse.id, text, Boolean(result.isError)));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await traceLogger.log({ ...traceCtx, event: "tool_result", tool: toolUse.name, output: message, isError: true });
          resultBlocks.push(buildToolResultBlock(toolUse.id, message, true));
        }
      }

      messages.push({ role: "user", content: resultBlocks as unknown as Anthropic.MessageParam["content"] });
    }

    await traceLogger.log({ ...traceCtx, event: "agent_end", output: finalText });
    return finalText;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await traceLogger.log({ ...traceCtx, event: "error", output: message });
    throw err;
  } finally {
    await mcpClient.close();
  }
}
