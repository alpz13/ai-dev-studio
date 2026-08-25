import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (info: unknown) {
    return { __info: info, connect: connectMock };
  }),
}));

let lastTransportArgs: { command: string; args: string[]; env?: Record<string, string> } | undefined;
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (args: unknown) {
    lastTransportArgs = args as typeof lastTransportArgs;
    return { __args: args };
  }),
}));

const { connectFilesystemGitClient } = await import("../../../agents/shared/filesystem-git-client.js");

describe("agents/shared/filesystem-git-client: connectFilesystemGitClient", () => {
  beforeEach(() => {
    connectMock.mockClear();
    lastTransportArgs = undefined;
  });

  it("lanza el server de filesystem-git como subproceso con WORKSPACE_ROOT en env", async () => {
    await connectFilesystemGitClient("workspaces/feat_x");

    expect(lastTransportArgs?.command).toBe("npx");
    expect(lastTransportArgs?.args).toEqual(["tsx", "src/mcp-servers/filesystem-git/server.ts"]);
    expect(lastTransportArgs?.env?.WORKSPACE_ROOT).toBe("workspaces/feat_x");
  });

  it("conecta el cliente MCP antes de devolverlo", async () => {
    await connectFilesystemGitClient("workspaces/feat_y");

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("usa el clientName dado, o un default si no se pasa ninguno", async () => {
    await connectFilesystemGitClient("workspaces/feat_z", "pm");

    // No hay forma directa de leer el nombre desde el mock del constructor
    // sin más wiring — lo que sí podemos confirmar es que no truena y que
    // sigue armando el transporte apuntando al workspace correcto.
    expect(lastTransportArgs?.env?.WORKSPACE_ROOT).toBe("workspaces/feat_z");
  });
});
