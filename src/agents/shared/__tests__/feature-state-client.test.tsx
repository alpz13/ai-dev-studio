import { describe, expect, it, vi } from "vitest";
import {
  getFeatureState,
  listPendingFeatures,
  updateFeatureState,
  type FeatureStateToolsClient,
} from "../../../agents/shared/feature-state-client.js";

// getFeatureState/updateFeatureState/listPendingFeatures only need an
// object with callTool (FeatureStateToolsClient) — they're tested with a
// fake one, without mocking any module.
function fakeClient(
  handler: (input: { name: string; arguments: Record<string, unknown> }) => {
    content: Array<{ text?: string }>;
    isError?: boolean;
  },
): FeatureStateToolsClient {
  return { callTool: async (input) => handler(input) };
}

describe("agents/shared/feature-state-client: pure functions (fake client)", () => {
  describe("getFeatureState", () => {
    it("parses the JSON when the feature exists", async () => {
      const state = { featureId: "feat_x", title: "X", status: "in_progress", currentStage: "Dev", stages: {} };
      const client = fakeClient(() => ({ content: [{ text: JSON.stringify(state) }] }));

      const result = await getFeatureState(client, "feat_x");

      expect(result).toEqual(state);
    });

    it("returns null when the server responds 'No state exists'", async () => {
      const client = fakeClient(() => ({ content: [{ text: 'No state exists for "feat_no_existe".' }] }));

      const result = await getFeatureState(client, "feat_no_existe");

      expect(result).toBeNull();
    });

    it("returns null if the tool responded isError", async () => {
      const client = fakeClient(() => ({ content: [{ text: "boom" }], isError: true }));

      const result = await getFeatureState(client, "feat_x");

      expect(result).toBeNull();
    });

    it("passes the correct featureId to the tool", async () => {
      let received: unknown;
      const client = fakeClient((input) => {
        received = input;
        return { content: [{ text: "No state exists" }] };
      });

      await getFeatureState(client, "feat_especifico");

      expect(received).toEqual({ name: "get_feature_state", arguments: { featureId: "feat_especifico" } });
    });
  });

  describe("updateFeatureState", () => {
    it("parses the JSON returned by the tool", async () => {
      const state = { featureId: "feat_x", title: "X", status: "done", currentStage: "DevOps", stages: {} };
      const client = fakeClient(() => ({ content: [{ text: JSON.stringify(state) }] }));

      const result = await updateFeatureState(client, { featureId: "feat_x", status: "done" });

      expect(result).toEqual(state);
    });

    it("throws a readable error if the tool responds isError", async () => {
      const client = fakeClient(() => ({ content: [{ text: "something went wrong" }], isError: true }));

      await expect(updateFeatureState(client, { featureId: "feat_x" })).rejects.toThrow(/something went wrong/);
    });

    it("passes the full input as the tool's arguments", async () => {
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
    it("parses the array returned by the tool", async () => {
      const pending = [{ featureId: "feat_a", title: "A", status: "in_progress", currentStage: "Dev", stages: {} }];
      const client = fakeClient(() => ({ content: [{ text: JSON.stringify(pending) }] }));

      const result = await listPendingFeatures(client);

      expect(result).toEqual(pending);
    });

    it("throws a readable error if the tool responds isError", async () => {
      const client = fakeClient(() => ({ content: [{ text: "boom" }], isError: true }));

      await expect(listPendingFeatures(client)).rejects.toThrow(/boom/);
    });
  });
});

describe("agents/shared/feature-state-client: connectFeatureStateClient", () => {
  it("creates the transport pointing at the feature-state server and connects the client", async () => {
    vi.resetModules();

    const connectMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: vi.fn().mockImplementation(function () { return { connect: connectMock }; }),
    }));

    let lastTransportArgs: unknown;
    vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
      StdioClientTransport: vi.fn().mockImplementation(function (args) {
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
