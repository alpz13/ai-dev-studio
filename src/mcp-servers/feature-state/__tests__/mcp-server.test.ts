import { describe, it, expect, vi, beforeAll } from 'vitest';

const mockEnsureDir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReadState = vi.hoisted(() => vi.fn());
const mockUpsertState = vi.hoisted(() => vi.fn());
const mockListPending = vi.hoisted(() => vi.fn());
const capturedHandlers = vi.hoisted(() => new Map<unknown, Function>());

vi.mock('../../../feature-state/store.js', () => ({
  FeatureStateStore: class MockFeatureStateStore {
    ensureDir = mockEnsureDir;
    readState = mockReadState;
    upsertState = mockUpsertState;
    listPending = mockListPending;
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class MockServer {
    setRequestHandler(schema: unknown, handler: Function) {
      capturedHandlers.set(schema, handler);
    }
    connect() {
      return Promise.resolve();
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockStdioServerTransport {},
}));

let CallToolRequestSchema: unknown;
let ListToolsRequestSchema: unknown;

beforeAll(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // Importamos los schemas reales (no mockeados) para usarlos como clave de búsqueda
  const types = await import('@modelcontextprotocol/sdk/types.js');
  CallToolRequestSchema = types.CallToolRequestSchema;
  ListToolsRequestSchema = types.ListToolsRequestSchema;

  // Cargar el servidor; el código a nivel de módulo (incluyendo main()) se ejecuta aquí
  await import('../server.js');
});

describe('Feature State MCP Server', () => {
  describe('list_tools — registro de herramientas', () => {
    it('registra exactamente 3 herramientas', async () => {
      const handler = capturedHandlers.get(ListToolsRequestSchema) as Function;
      const result = await handler({});
      expect(result.tools).toHaveLength(3);
    });

    it('expone get_feature_state, update_feature_state y list_pending_features', async () => {
      const handler = capturedHandlers.get(ListToolsRequestSchema) as Function;
      const { tools } = await handler({});
      const names = tools.map((t: { name: string }) => t.name);
      expect(names).toContain('get_feature_state');
      expect(names).toContain('update_feature_state');
      expect(names).toContain('list_pending_features');
    });
  });

  describe('get_feature_state', () => {
    it('devuelve el JSON del estado si la feature existe', async () => {
      const fakeState = { featureId: 'feat_test', title: 'Test feature' };
      mockReadState.mockResolvedValue(fakeState);

      const handler = capturedHandlers.get(CallToolRequestSchema) as Function;
      const result = await handler({
        params: { name: 'get_feature_state', arguments: { featureId: 'feat_test' } },
      });

      expect(mockReadState).toHaveBeenCalledWith('feat_test');
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('"featureId": "feat_test"');
    });

    it('devuelve mensaje de no encontrado si el estado es null', async () => {
      mockReadState.mockResolvedValue(null);

      const handler = capturedHandlers.get(CallToolRequestSchema) as Function;
      const result = await handler({
        params: { name: 'get_feature_state', arguments: { featureId: 'feat_missing' } },
      });

      expect(result.content[0].text).toContain('No state exists for');
      expect(result.content[0].text).toContain('feat_missing');
    });
  });

  describe('update_feature_state', () => {
    it('llama a upsertState y devuelve el estado actualizado como JSON', async () => {
      const updated = { featureId: 'feat_x', status: 'in_progress', title: 'X' };
      mockUpsertState.mockResolvedValue(updated);

      const handler = capturedHandlers.get(CallToolRequestSchema) as Function;
      const result = await handler({
        params: {
          name: 'update_feature_state',
          arguments: { featureId: 'feat_x', status: 'in_progress' },
        },
      });

      expect(mockUpsertState).toHaveBeenCalledWith(
        expect.objectContaining({ featureId: 'feat_x', status: 'in_progress' }),
      );
      expect(result.content[0].text).toContain('"featureId": "feat_x"');
    });
  });

  describe('list_pending_features', () => {
    it('devuelve la lista de features pendientes como JSON', async () => {
      const pending = [{ featureId: 'feat_a' }, { featureId: 'feat_b' }];
      mockListPending.mockResolvedValue(pending);

      const handler = capturedHandlers.get(CallToolRequestSchema) as Function;
      const result = await handler({
        params: { name: 'list_pending_features', arguments: {} },
      });

      expect(mockListPending).toHaveBeenCalled();
      expect(result.content[0].text).toContain('feat_a');
      expect(result.content[0].text).toContain('feat_b');
    });
  });

  it('lanza error para una herramienta desconocida', async () => {
    const handler = capturedHandlers.get(CallToolRequestSchema) as Function;
    const result = await handler({ params: { name: 'unknown_tool', arguments: {} } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });
});
