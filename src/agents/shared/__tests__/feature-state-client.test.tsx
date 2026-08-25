import { describe, expect, it, vi } from "vitest";
import {
  getFeatureState,
  listPendingFeatures,
  updateFeatureState,
  type FeatureStateToolsClient,
} from "../../../agents/shared/feature-state-client.js";

// getFeatureState/updateFeatureState/listPendingFeatures solo necesitan un
// objeto con callTool (FeatureStateToolsClient) — se prueban con uno falso,
// sin mockear ningún módulo.
function fakeClient(
  handler: (input: { name: string; arguments: Record<string, unknown> }) => {
    content: Array<{ text?: string }>;
    isError?: boolean;
  },
): FeatureStateToolsClient {
  return { callTool: async (input) => handler(input) };
}

describe("agents/shared/feature-state-client: funciones puras (cliente falso)", () => {
  describe("getFeatureState", () => {
    it("parsea el JSON cuando la feature existe", async () => {
      const state = { featureId: "feat_x", title: "X", status: "in_progress", currentStage: "Dev", stages: {} };
      const client = fakeClient(() => ({ content: [{ text: JSON.stringify(state) }] }));

      const result = await getFeatureState(client, "feat_x");

      expect(result).toEqual(state);
    });

    it("devuelve null cuando el server responde 'No existe estado'", async () => {
      const client = fakeClient(() => ({ content: [{ text: 'No existe estado para "feat_no_existe".' }] }));

      const result = await getFeatureState(client, "feat_no_existe");

      expect(result).toBeNull();
    });

    it("devuelve null si la tool respondió isError", async () => {
      const client = fakeClient(() => ({ content: [{ text: "boom" }], isError: true }));

      const result = await getFeatureState(client, "feat_x");

      expect(result).toBeNull();
    });

    it("pasa el featureId correcto a la tool", async () => {
      let received: unknown;
      const client = fakeClient((input) => {
        received = input;
        return { content: [{ text: "No existe estado" }] };
      });

      await getFeatureState(client, "feat_especifico");

      expect(received).toEqual({ name: "get_feature_state", arguments: { featureId: "feat_especifico" } });
    });
  });

  describe("updateFeatureState", () => {
    it("parsea el JSON devuelto por la tool", async () => {
      const state = { featureId: "feat_x", title: "X", status: "done", currentStage: "DevOps", stages: {} };
      const client = fakeClient(() => ({ content: [{ text: JSON.stringify(state) }] }));

      const result = await updateFeatureState(client, { featureId: "feat_x", status: "done" });

      expect(result).toEqual(state);
    });

    it("lanza un error legible si la tool responde isError", async () => {
      const client = fakeClient(() => ({ content: [{ text: "algo salió mal" }], isError: true }));

      await expect(updateFeatureState(client, { featureId: "feat_x" })).rejects.toThrow(/algo salió mal/);
    });

    it("pasa el input completo como arguments de la tool", async () => {
      let received: unknown;
      const client = fakeClient((input) => {
        received = input;
        return { content: [{ text: "{}" }] };
      });

      await updateFeatureState(client, { featureId: "feat_x", currentStage: "QA", status: "in_progress" });

      expect(received).toEqual({
        name: "update_feature_state",
        arguments: { featureId: "feat_x", currentStage: "QA", status: "in_progress" },
      });
    });
  });

  describe("listPendingFeatures", () => {
    it("parsea el arreglo devuelto por la tool", async () => {
      const pending = [{ featureId: "feat_a", title: "A", status: "in_progress", currentStage: "Dev", stages: {} }];
      const client = fakeClient(() => ({ content: [{ text: JSON.stringify(pending) }] }));

      const result = await listPendingFeatures(client);

      expect(result).toEqual(pending);
    });

    it("lanza un error legible si la tool responde isError", async () => {
      const client = fakeClient(() => ({ content: [{ text: "boom" }], isError: true }));

      await expect(listPendingFeatures(client)).rejects.toThrow(/boom/);
    });
  });
});

describe("agents/shared/feature-state-client: connectFeatureStateClient", () => {
  it("crea el transporte apuntando al server de feature-state y conecta el cliente", async () => {
    vi.resetModules();

    const connectMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(function () {
        return { connect: connectMock };
      }),
    }));

    let lastTransportArgs: unknown;
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(function (args: unknown) {
        lastTransportArgs = args;
        return { __args: args };
      }),
    }));

    const { connectFeatureStateClient } = await import("../../../agents/shared/feature-state-client.js");
    await connectFeatureStateClient("test-client");

    expect(lastTransportArgs).toMatchObject({
      command: "npx",
      args: ["tsx", "src/mcp-servers/feature-state/server.ts"],
    });
    expect(connectMock).toHaveBeenCalledTimes(1);

    vi.doUnmock("@modelcontextprotocol/sdk/client/index.js");
    vi.doUnmock("@modelcontextprotocol/sdk/client/stdio.js");
    vi.resetModules();
  });
});
