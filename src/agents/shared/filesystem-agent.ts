/**
 * Factory for agents that only need the filesystem-git MCP: they receive
 * a task, run the agentic loop (see run-agent-loop.ts) against that single
 * MCP, and log every step. PM, Architect, Dev, QA, and DevOps are all
 * instances of this same factory — only the system prompt, the agentRole,
 * and (since Phase 4, only for Dev) whether subagents are allowed change —
 * see src/agents/<role>/agent.ts, all just a few lines long.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { newSpanId, TraceLogger } from "../../observability/trace-logger.js";
import { connectFilesystemGitClient } from "./filesystem-git-client.js";
import { runAgentLoop, type AnthropicMessagesClient, type McpToolsClient, type SubagentToolConfig } from "./run-agent-loop.js";

export interface FilesystemAgentOptions {
  featureId: string;
  task: string;
  workspaceRoot: string;
}

export type FilesystemAgentRunner = (opts: FilesystemAgentOptions) => Promise<string>;

export interface CreateFilesystemAgentOptions {
  /**
   * Phase 4 — SubAgents: if true, the agent receives the
   * delegate_to_subagent tool and decides for itself (in its own loop,
   * with no external code forcing it) whether it's worth splitting the
   * task into pieces by file/module and delegating each one to a subagent
   * of the same role. The subagent shares the same MCP client (same
   * workspace/git) but runs with its own spanId, with parentSpanId = this
   * agent's — so it ends up nested in the trace (see ARCHITECTURE.md
   * section 3).
   */
  allowSubagents?: boolean;
  /** Description of the tool the model sees; defaults to a reasonably generic one. */
  subagentToolDescription?: string;
  /** Subagent's system prompt; defaults to the parent agent's own + a scope note. */
  subagentSystemPrompt?: (module: string) => string;
}

export function createFilesystemAgent(
  agentRole: string,
  systemPrompt: string,
  createOpts: CreateFilesystemAgentOptions = {},
): FilesystemAgentRunner {
  return async function runFilesystemAgent(opts: FilesystemAgentOptions): Promise<string> {
    const traceLogger = new TraceLogger();
    const spanId = newSpanId(`agt_${agentRole.toLowerCase()}`);
    const traceCtx = { traceId: opts.featureId, spanId, agentRole };

    await traceLogger.log({
      ...traceCtx,
      event: "agent_start",
      input: { task: opts.task, workspaceRoot: opts.workspaceRoot },
    });

    const anthropic = new Anthropic();
    const mcpClient = await connectFilesystemGitClient(opts.workspaceRoot, agentRole.toLowerCase());

    try {
      const subagentTool: SubagentToolConfig | undefined = createOpts.allowSubagents
        ? {
            description:
              createOpts.subagentToolDescription ??
              `Delegates a scoped portion of the task (a specific file or module, clearly separable from the rest) to an independent ${agentRole} subagent. The subagent works in the same workspace/git as you and gives you back a summary of what it did when it's done. Use it only when the task spans several files or modules that are separable from each other — for a single-file task, do it yourself directly.`,
            run: async ({ module, task }) => {
              const subSpanId = newSpanId(`agt_${agentRole.toLowerCase()}_sub`);
              const subTraceCtx = { traceId: opts.featureId, spanId: subSpanId, parentSpanId: spanId, agentRole };

              await traceLogger.log({
                ...subTraceCtx,
                event: "agent_start",
                input: { task, module, workspaceRoot: opts.workspaceRoot, delegatedBy: spanId },
              });

              try {
                const subSystemPrompt = createOpts.subagentSystemPrompt
                  ? createOpts.subagentSystemPrompt(module)
                  : `${systemPrompt}\n\nYou are a ${agentRole} subagent, delegated by the main ${agentRole} agent to handle exclusively this portion: "${module}". Do not touch files outside that scope unless it's essential for your own task. When you're done, reply with a brief summary in plain text.`;

                let subUsage = { inputTokens: 0, outputTokens: 0 };
                const finalText = await runAgentLoop({
                  anthropic: anthropic as unknown as AnthropicMessagesClient,
                  mcpClient: mcpClient as unknown as McpToolsClient,
                  systemPrompt: subSystemPrompt,
                  task,
                  traceLogger,
                  traceCtx: subTraceCtx,
                  // Subagents don't in turn get the ability to delegate —
                  // a single level of nesting is enough for what
                  // ARCHITECTURE.md asks for (Dev splitting a large task by module).
                  onUsage: (usage) => { subUsage = usage; },
                });

                await traceLogger.log({
                  ...subTraceCtx,
                  event: "agent_end",
                  output: finalText,
                  tokensUsed: subUsage.inputTokens + subUsage.outputTokens,
                });
                return finalText;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                await traceLogger.log({ ...subTraceCtx, event: "error", output: message });
                throw err;
              }
            },
          }
        : undefined;

      let usage = { inputTokens: 0, outputTokens: 0 };
      const finalText = await runAgentLoop({
        anthropic: anthropic as unknown as AnthropicMessagesClient,
        mcpClient: mcpClient as unknown as McpToolsClient,
        systemPrompt,
        task: opts.task,
        traceLogger,
        traceCtx,
        subagentTool,
        onUsage: (u) => { usage = u; },
      });

      await traceLogger.log({
        ...traceCtx,
        event: "agent_end",
        output: finalText,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      });
      return finalText;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await traceLogger.log({ ...traceCtx, event: "error", output: message });
      throw err;
    } finally {
      await mcpClient.close();
    }
  };
}
