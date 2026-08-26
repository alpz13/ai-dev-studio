import { beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop, type AnthropicMessagesClient, type McpToolsClient, type TraceLoggerLike } from "../../../agents/shared/run-agent-loop.js";
import type { TraceEventInput } from "../../../observability/trace-logger.js";

// This engine receives `anthropic` and `mcpClient` injected (see the
// comment in the source file), so it can be tested with plain objects that
// satisfy the minimal shape — no vi.mock, no SDK installed.

function fakeTraceLogger(): TraceLoggerLike & { events: TraceEventInput[] } {
  const events: TraceEventInput[] = [];
  return {
    events,
    log: async (event) => {
      events.push(event);
      return event;
    },
  };
}

function textResponse(text: string) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" as const };
}

function toolUseResponse(id: string, name: string, input: unknown) {
  return { content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" as const };
}

const traceCtx = { traceId: "feat_test", spanId: "agt_1", agentRole: "TestRole" };

describe("agents/shared/run-agent-loop", () => {
  let mcpClient: McpToolsClient & { calls: Array<{ name: string; arguments: Record<string, unknown> }> };

  beforeEach(() => {
    mcpClient = {
      calls: [],
      listTools: async () => ({
        tools: [{ name: "write_file", description: "Writes a file", inputSchema: { type: "object" } }],
      }),
      callTool: async (input) => {
        mcpClient.calls.push(input);
        return { content: [{ text: "Written: hello.txt" }], isError: false };
      },
    };
  });

  it("happy path: one tool call and then a final response, with tool_call/tool_result logged in order", async () => {
    let call = 0;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          call++;
          return call === 1
            ? toolUseResponse("toolu_1", "write_file", { path: "hello.txt", content: "hello" })
            : textResponse("Done, I created hello.txt.");
        },
      },
    };
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "test system",
      task: "create hello.txt",
      traceLogger,
      traceCtx,
    });

    expect(result).toBe("Done, I created hello.txt.");
    expect(mcpClient.calls).toEqual([{ name: "write_file", arguments: { path: "hello.txt", content: "hello" } }]);
    expect(traceLogger.events.map((e) => e.event)).toEqual(["tool_call", "tool_result"]);
    expect(traceLogger.events[0].traceId).toBe("feat_test");
    expect(traceLogger.events[0].agentRole).toBe("TestRole");
  });

  it("answers right away without requesting tools if the first turn is already the final response (logs nothing)", async () => {
    const anthropic: AnthropicMessagesClient = {
      messages: { create: async () => textResponse("No need to touch any files.") },
    };
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "system",
      task: "just answer",
      traceLogger,
      traceCtx,
    });

    expect(result).toBe("No need to touch any files.");
    expect(mcpClient.calls).toEqual([]);
    expect(traceLogger.events).toEqual([]);
  });

  it("a tool error is logged as isError and the loop continues until the final response", async () => {
    let call = 0;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          call++;
          return call === 1
            ? toolUseResponse("toolu_1", "write_file", { path: "../outside.txt", content: "x" })
            : textResponse("Fixed.");
        },
      },
    };
    mcpClient.callTool = async () => {
      throw new Error("Path outside the allowed workspace");
    };
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "system",
      task: "try something invalid",
      traceLogger,
      traceCtx,
    });

    expect(result).toBe("Fixed.");
    const toolResult = traceLogger.events.find((e) => e.event === "tool_result");
    expect(toolResult?.isError).toBe(true);
    expect(String(toolResult?.output)).toMatch(/outside the allowed workspace/);
  });

  it("respects maxTurns and returns an empty string if the model never stops requesting tools", async () => {
    let calls = 0;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          calls++;
          return toolUseResponse(`toolu_${calls}`, "write_file", { path: "a.txt", content: "x" });
        },
      },
    };
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "system",
      task: "never finishes",
      traceLogger,
      traceCtx,
      maxTurns: 3,
    });

    expect(result).toBe("");
    expect(calls).toBe(3);
  });

  it("translates the MCP tools into Anthropic tools on every call to create", async () => {
    let receivedTools: unknown;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async (params) => {
          receivedTools = params.tools;
          return textResponse("done");
        },
      },
    };

    await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "system",
      task: "something",
      traceLogger: fakeTraceLogger(),
      traceCtx,
    });

    expect(receivedTools).toEqual([
      { name: "write_file", description: "Writes a file", input_schema: { type: "object" } },
    ]);
  });

  it("uses the given system prompt and task in the first message", async () => {
    let receivedSystem: string | undefined;
    let receivedMessages: unknown;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async (params) => {
          receivedSystem = params.system;
          // Careful: `messages` is the same array the loop keeps mutating
          // after this `create()` call (it pushes the assistant's response
          // before breaking out of the loop) — it needs to be copied here,
          // otherwise `receivedMessages` would "see" that later push by
          // reference.
          receivedMessages = [...params.messages];
          return textResponse("ok");
        },
      },
    };

    await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "You are a test agent.",
      task: "do something specific",
      traceLogger: fakeTraceLogger(),
      traceCtx,
    });

    expect(receivedSystem).toBe("You are a test agent.");
    expect(receivedMessages).toEqual([{ role: "user", content: "do something specific" }]);
  });
});

// Phase 4 — SubAgents: delegate_to_subagent is a synthetic tool (it does
// not come from the MCP) that only appears when `subagentTool` is passed,
// and when the model invokes it the loop calls `subagentTool.run()`
// instead of `mcpClient.callTool()`. See createFilesystemAgent
// (filesystem-agent.ts) for how `run()` is actually built, with its own
// nested spanId.
describe("agents/shared/run-agent-loop: subagentTool (Phase 4)", () => {
  let mcpClient: McpToolsClient & { calls: Array<{ name: string; arguments: Record<string, unknown> }> };

  beforeEach(() => {
    mcpClient = {
      calls: [],
      listTools: async () => ({
        tools: [{ name: "write_file", description: "Writes a file", inputSchema: { type: "object" } }],
      }),
      callTool: async (input) => {
        mcpClient.calls.push(input);
        return { content: [{ text: "Written" }], isError: false };
      },
    };
  });

  it("without subagentTool, the model never sees the delegate_to_subagent tool (regression)", async () => {
    let receivedTools: unknown;
    const anthropic: AnthropicMessagesClient = {
      messages: { create: async (params) => { receivedTools = params.tools; return textResponse("done"); } },
    };

    await runAgentLoop({ anthropic, mcpClient, systemPrompt: "s", task: "t", traceLogger: fakeTraceLogger(), traceCtx });

    expect(receivedTools).toEqual([
      { name: "write_file", description: "Writes a file", input_schema: { type: "object" } },
    ]);
  });

  it("with subagentTool, delegate_to_subagent is added to the tools with its schema", async () => {
    let receivedTools: any;
    const anthropic: AnthropicMessagesClient = {
      messages: { create: async (params) => { receivedTools = params.tools; return textResponse("done"); } },
    };

    await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "s",
      task: "t",
      traceLogger: fakeTraceLogger(),
      traceCtx,
      subagentTool: { description: "delegates a portion", run: async () => "done" },
    });

    expect(receivedTools).toHaveLength(2);
    const delegateTool = receivedTools.find((t: any) => t.name === "delegate_to_subagent");
    expect(delegateTool).toBeDefined();
    expect(delegateTool.description).toBe("delegates a portion");
    expect(delegateTool.input_schema).toEqual({
      type: "object",
      properties: {
        module: { type: "string", description: "Specific file or module the subagent will work on." },
        task: { type: "string", description: "Specific, scoped task for that module." },
      },
      required: ["module", "task"],
    });
  });

  it("when delegate_to_subagent is invoked, it runs subagentTool.run() (not mcpClient.callTool) and returns its result as tool_result", async () => {
    let call = 0;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          call++;
          return call === 1
            ? toolUseResponse("toolu_1", "delegate_to_subagent", { module: "validation.ts", task: "add validation" })
            : textResponse("Done, both pieces finished.");
        },
      },
    };
    const runCalls: Array<{ module: string; task: string }> = [];
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "s",
      task: "create the endpoint and its validation",
      traceLogger,
      traceCtx,
      subagentTool: {
        description: "delegates",
        run: async (input) => {
          runCalls.push(input);
          return "Subagent done: added the validation in validation.ts.";
        },
      },
    });

    expect(result).toBe("Done, both pieces finished.");
    expect(mcpClient.calls).toEqual([]); // never went through the MCP
    expect(runCalls).toEqual([{ module: "validation.ts", task: "add validation" }]);

    const toolResult = traceLogger.events.find((e) => e.event === "tool_result");
    expect(toolResult?.tool).toBe("delegate_to_subagent");
    expect(toolResult?.isError).toBe(false);
    expect(String(toolResult?.output)).toMatch(/Subagent done/);
  });

  it("if subagentTool.run() throws, it is logged as isError and the loop continues (the parent sees the error and can retry)", async () => {
    let call = 0;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          call++;
          return call === 1
            ? toolUseResponse("toolu_1", "delegate_to_subagent", { module: "broken.ts", task: "something" })
            : textResponse("I'll do it myself directly then.");
        },
      },
    };
    const traceLogger = fakeTraceLogger();

    const result = await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "s",
      task: "t",
      traceLogger,
      traceCtx,
      subagentTool: {
        description: "delegates",
        run: async () => {
          throw new Error("the subagent blew up");
        },
      },
    });

    expect(result).toBe("I'll do it myself directly then.");
    const toolResult = traceLogger.events.find((e) => e.event === "tool_result");
    expect(toolResult?.isError).toBe(true);
    expect(String(toolResult?.output)).toMatch(/the subagent blew up/);
  });

  it("a tool_use with the same name as a normal MCP tool still goes to the mcpClient if it doesn't match the configured subagentTool name", async () => {
    let call = 0;
    const anthropic: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          call++;
          return call === 1
            ? toolUseResponse("toolu_1", "write_file", { path: "a.txt", content: "x" })
            : textResponse("done");
        },
      },
    };

    await runAgentLoop({
      anthropic,
      mcpClient,
      systemPrompt: "s",
      task: "t",
      traceLogger: fakeTraceLogger(),
      traceCtx,
      subagentTool: { name: "delegate_custom", description: "delegates", run: async () => "should not be called" },
    });

    expect(mcpClient.calls).toEqual([{ name: "write_file", arguments: { path: "a.txt", content: "x" } }]);
  });
});
