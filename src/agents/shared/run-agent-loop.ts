/**
 * El loop agentic manual (Messages API + tool use), extraído de lo que
 * originalmente vivía solo dentro del agente Dev (Fase 2), para que
 * cualquier agente basado en un MCP de herramientas (PM, Arquitecto, Dev,
 * QA, DevOps — Fase 3) lo reutilice sin duplicar la mecánica.
 *
 * A propósito recibe `anthropic` y `mcpClient` ya construidos/conectados
 * (inyección de dependencias) en vez de crearlos él mismo: así se puede
 * probar con objetos falsos simples, sin necesidad de mockear ningún
 * módulo de los SDKs.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { TraceContext, TraceEventInput } from "../../observability/trace-logger.js";
import { buildToolResultBlock, extractText, extractToolUseBlocks, type ContentBlock } from "./agent-loop-helpers.js";
import { mcpToolsToAnthropicTools } from "./mcp-tool-adapter.js";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TURNS = 12;

// Solo la porción de las interfaces de @anthropic-ai/sdk y
// @modelcontextprotocol/sdk que este loop realmente usa — así el motor no
// depende de los tipos exactos de ninguno de los dos SDKs, y una prueba
// puede pasar un objeto plano que cumpla este shape sin instalar nada.
export interface AnthropicMessagesClient {
  messages: {
    create: (params: {
      model: string;
      max_tokens: number;
      system: string;
      tools: unknown;
      messages: Anthropic.MessageParam[];
    }) => Promise<{ content: unknown; stop_reason: string | null }>;
  };
}

export interface McpToolsClient {
  listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>;
  callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<{
    content: Array<{ text?: string }>;
    isError?: boolean;
  }>;
}

// Igual que arriba: solo la porción de TraceLogger que el loop usa, para
// poder probar con un logger falso (un array que va acumulando llamadas)
// sin instanciar la clase real ni tocar su campo privado logsDir.
export interface TraceLoggerLike {
  log: (event: TraceEventInput) => Promise<unknown>;
}

export interface RunAgentLoopOptions {
  anthropic: AnthropicMessagesClient;
  mcpClient: McpToolsClient;
  systemPrompt: string;
  task: string;
  traceLogger: TraceLoggerLike;
  traceCtx: TraceContext;
  model?: string;
  maxTurns?: number;
}

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<string> {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  const { tools: mcpTools } = await opts.mcpClient.listTools();
  const tools = mcpToolsToAnthropicTools(
    mcpTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  );

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.task }];
  let finalText = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await opts.anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: opts.systemPrompt,
      tools,
      messages,
    });

    const content = response.content as unknown as ContentBlock[];
    messages.push({ role: "assistant", content: response.content as unknown as Anthropic.MessageParam["content"] });

    const toolUses = extractToolUseBlocks(content);

    if (toolUses.length === 0 || response.stop_reason !== "tool_use") {
      finalText = extractText(content);
      break;
    }

    const resultBlocks = [];
    for (const toolUse of toolUses) {
      await opts.traceLogger.log({ ...opts.traceCtx, event: "tool_call", tool: toolUse.name, input: toolUse.input });
      try {
        const result = await opts.mcpClient.callTool({
          name: toolUse.name,
          arguments: toolUse.input as Record<string, unknown>,
        });
        const text = result.content.map((c) => c.text ?? "").join("\n");
        await opts.traceLogger.log({
          ...opts.traceCtx,
          event: "tool_result",
          tool: toolUse.name,
          output: text,
          isError: Boolean(result.isError),
        });
        resultBlocks.push(buildToolResultBlock(toolUse.id, text, Boolean(result.isError)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await opts.traceLogger.log({ ...opts.traceCtx, event: "tool_result", tool: toolUse.name, output: message, isError: true });
        resultBlocks.push(buildToolResultBlock(toolUse.id, message, true));
      }
    }

    messages.push({ role: "user", content: resultBlocks as unknown as Anthropic.MessageParam["content"] });
  }

  return finalText;
}
