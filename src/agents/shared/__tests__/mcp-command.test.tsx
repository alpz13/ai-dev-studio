import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpServerCommand } from "../mcp-command.js";

describe("agents/shared/mcp-command: mcpServerCommand", () => {
  // NODE_ENV is restored rather than blindly deleted: the test runner itself
  // sets it, and leaking a deletion into sibling tests would be a hidden
  // cross-test dependency.
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("runs the TS source with tsx when NODE_ENV is not production", () => {
    delete process.env.NODE_ENV;
    expect(mcpServerCommand("src/mcp-servers/feature-state/server.ts")).toEqual({
      command: "npx",
      args: ["tsx", "src/mcp-servers/feature-state/server.ts"],
    });
  });

  it("runs the compiled JS with node when NODE_ENV is production", () => {
    process.env.NODE_ENV = "production";
    const result = mcpServerCommand("src/mcp-servers/feature-state/server.ts");
    expect(result.command).toBe(process.execPath);
    expect(result.args).toEqual([path.join("dist", "src/mcp-servers/feature-state/server.js")]);
  });

  it("also maps the filesystem-git server to its compiled path in production", () => {
    process.env.NODE_ENV = "production";
    const result = mcpServerCommand("src/mcp-servers/filesystem-git/server.ts");
    expect(result.args).toEqual([path.join("dist", "src/mcp-servers/filesystem-git/server.js")]);
  });
});
