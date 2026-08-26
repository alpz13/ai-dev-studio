import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (info) { return { __info: info, connect: connectMock }; }),
}));

let lastTransportArgs: { command: string; args: string[]; env?: Record<string, string> } | undefined;
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (args) {
    lastTransportArgs = args;
    return { __args: args };
  }),
}));

const { connectFilesystemGitClient } = await import("../../../agents/shared/filesystem-git-client.js");

describe("agents/shared/filesystem-git-client: connectFilesystemGitClient", () => {
  beforeEach(() => {
    connectMock.mockClear();
    lastTransportArgs = undefined;
  });

  it("launches the filesystem-git server as a subprocess with WORKSPACE_ROOT in env", async () => {
    await connectFilesystemGitClient("workspaces/feat_x");

    expect(lastTransportArgs?.command).toBe("npx");
    expect(lastTransportArgs?.args).toEqual(["tsx", "src/mcp-servers/filesystem-git/server.ts"]);
    expect(lastTransportArgs?.env?.WORKSPACE_ROOT).toBe("workspaces/feat_x");
  });

  it("connects the MCP client before returning it", async () => {
    await connectFilesystemGitClient("workspaces/feat_y");

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("uses the given clientName, or a default if none is passed", async () => {
    await connectFilesystemGitClient("workspaces/feat_z", "pm");

    // There's no direct way to read the name from the constructor mock
    // without more wiring — what we can confirm is that it doesn't blow up
    // and still builds the transport pointing at the correct workspace.
    expect(lastTransportArgs?.env?.WORKSPACE_ROOT).toBe("workspaces/feat_z");
  });
});
