/**
 * The manual agentic loop (Messages API + tool use), extracted from what
 * originally lived only inside the Dev agent (Phase 2), so that any agent
 * built on a tool MCP (PM, Architect, Dev, QA, DevOps — Phase 3) can reuse
 * it without duplicating the mechanics.
 *
 * It deliberately receives `anthropic` and `mcpClient` already
 * built/connected (dependency injection) instead of creating them itself:
 * that way it can be tested with simple fake objects, without needing to
 * mock any SDK module.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { TraceContext, TraceEventInput } from "../../observability/trace-logger.js";
import { buildToolResultBlock, extractText, extractToolUseBlocks, type ContentBlock } from "./agent-loop-helpers.js";
import { mcpToolsToAnthropicTools } from "./mcp-tool-adapter.js";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TURNS = 12;

// Only the portion of the @anthropic-ai/sdk and @modelcontextprotocol/sdk
// interfaces that this loop actually uses — so the engine doesn't depend
// on the exact types of either SDK, and a test can pass a plain object
// matching this shape without installing anything.
export interface AnthropicMessagesClient {
  messages: {
    create: (params: {
      model: string;
      max_tokens: number;
      system: string;
      tools: unknown;
      messages: Anthropic.MessageParam[];
    }) => Promise<{
      content: unknown;
      stop_reason: string | null;
      // Real Anthropic responses always carry this; optional here only so
      // a minimal test fake doesn't have to include it when a test isn't
      // exercising usage tracking (see onUsage below).
      usage?: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export interface McpToolsClient {
  listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>;
  callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<{
    content: unknown[];
    isError?: boolean;
  }>;
}

// Same as above: only the portion of TraceLogger that the loop uses, so it
// can be tested with a fake logger (an array that accumulates calls)
// without instantiating the real class or touching its private logsDir
// field.
export interface TraceLoggerLike {
  log: (event: TraceEventInput) => Promise<unknown>;
}

// Phase 4 — SubAgents: a synthetic tool that does NOT come from the MCP.
// The model sees it as just another tool (see below where it's added to
// `tools`), but when it's invoked the loop doesn't ask the mcpClient — it
// runs a separate subagent (see createFilesystemAgent in
// filesystem-agent.ts) and returns its final summary as if it were the
// tool's result. So it's the model itself, in the middle of its normal
// loop, that decides whether it's worth delegating a portion of the task —
// not a code rule.
export interface SubagentToolConfig {
  /** Name of the synthetic tool the model sees. Default: "delegate_to_subagent". */
  name?: string;
  /** Description the model sees — explains when delegating makes sense. */
  description: string;
  /** Runs the subagent and returns its final summary (or throws if it fails). */
  run: (input: { module: string; task: string }) => Promise<string>;
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
  subagentTool?: SubagentToolConfig;
  /**
   * Phase 6 — robust logging: called once, right before returning, with the
   * total input/output tokens summed across every turn of this loop (each
   * turn is one `messages.create()` call — a multi-tool-use task can take
   * several). Optional and additive: existing callers that don't pass it
   * see no behavior change. See filesystem-agent.ts for how it turns this
   * into the `tokensUsed` field on the agent_end trace event.
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

const DEFAULT_SUBAGENT_TOOL_NAME = "delegate_to_subagent";

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<string> {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const subagentToolName = opts.subagentTool?.name ?? DEFAULT_SUBAGENT_TOOL_NAME;

  const { tools: mcpTools } = await opts.mcpClient.listTools();
  const tools = mcpToolsToAnthropicTools(
    mcpTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  );

  if (opts.subagentTool) {
    tools.push({
      name: subagentToolName,
      description: opts.subagentTool.description,
      input_schema: {
        type: "object",
        properties: {
          module: { type: "string", description: "Specific file or module the subagent will work on." },
          task: { type: "string", description: "Specific, scoped task for that module." },
        },
        required: ["module", "task"],
      },
    });
  }

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.task }];
  let finalText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await opts.anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: opts.systemPrompt,
      tools,
      messages,
    });

    if (response.usage) {
      totalInputTokens += response.usage.input_tokens ?? 0;
      totalOutputTokens += response.usage.output_tokens ?? 0;
    }

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
        let text: string;
        let isError: boolean;

        if (opts.subagentTool && toolUse.name === subagentToolName) {
          // Delegation to a subagent instead of an MCP tool_call — see
          // SubagentToolConfig above and createFilesystemAgent, which builds
          // this `run()` with its own child spanId (parentSpanId = this agent).
          const input = toolUse.input as { module?: unknown; task?: unknown };
          text = await opts.subagentTool.run({ module: String(input.module ?? ""), task: String(input.task ?? "") });
          isError = false;
        } else {
          const result = await opts.mcpClient.callTool({
            name: toolUse.name,
            arguments: toolUse.input as Record<string, unknown>,
          });
          text = result.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
          isError = Boolean(result.isError);
        }

        await opts.traceLogger.log({ ...opts.traceCtx, event: "tool_result", tool: toolUse.name, output: text, isError });
        resultBlocks.push(buildToolResultBlock(toolUse.id, text, isError));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await opts.traceLogger.log({ ...opts.traceCtx, event: "tool_result", tool: toolUse.name, output: message, isError: true });
        resultBlocks.push(buildToolResultBlock(toolUse.id, message, true));
      }
    }

    messages.push({ role: "user", content: resultBlocks as unknown as Anthropic.MessageParam["content"] });
  }

  opts.onUsage?.({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens });
  return finalText;
}
