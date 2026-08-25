/**
 * Factory para agentes que solo necesitan el MCP filesystem-git: reciben
 * una tarea, corren el loop agentic (ver run-agent-loop.ts) contra ese
 * único MCP, y logean cada paso. PM, Arquitecto, Dev, QA y DevOps son todos
 * instancias de esta misma factory — solo cambia el system prompt y el
 * agentRole (ver src/agents/<rol>/agent.ts, todos de una línea).
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { newSpanId, TraceLogger } from "../../observability/trace-logger.js";
import { connectFilesystemGitClient } from "./filesystem-git-client.js";
import { runAgentLoop } from "./run-agent-loop.js";

export interface FilesystemAgentOptions {
  featureId: string;
  task: string;
  workspaceRoot: string;
}

export type FilesystemAgentRunner = (opts: FilesystemAgentOptions) => Promise<string>;

export function createFilesystemAgent(agentRole: string, systemPrompt: string): FilesystemAgentRunner {
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
      const finalText = await runAgentLoop({
        anthropic,
        mcpClient,
        systemPrompt,
        task: opts.task,
        traceLogger,
        traceCtx,
      });

      await traceLogger.log({ ...traceCtx, event: "agent_end", output: finalText });
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
