import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('dotenv/config', () => ({}));

const mockCreate = vi.hoisted(() => vi.fn());
const mockStream = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: mockCreate,
      stream: mockStream,
    };
  },
}));

import { sendMessage, streamMessage } from '../src/core/client.js';

describe('sendMessage', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('llama a messages.create con el prompt y parámetros por defecto', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hola mundo' }],
    });

    const result = await sendMessage('Hola');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Hola' }],
        max_tokens: 1024,
      }),
    );
    expect(result).toBe('Hola mundo');
  });

  it('respeta las opciones model, system y maxTokens', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'OK' }],
    });

    await sendMessage('test', {
      model: 'claude-custom',
      system: 'You are a helpful assistant',
      maxTokens: 512,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-custom',
        system: 'You are a helpful assistant',
        max_tokens: 512,
      }),
    );
  });

  it('devuelve cadena vacía si la respuesta no contiene bloque de texto', async () => {
    mockCreate.mockResolvedValue({ content: [] });

    const result = await sendMessage('test');
    expect(result).toBe('');
  });
});

describe('streamMessage', () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  it('registra el callback de texto y devuelve el texto final', async () => {
    const onDelta = vi.fn();
    const mockStreamInstance = {
      on: vi.fn(),
      finalMessage: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'respuesta en streaming' }],
      }),
    };
    mockStream.mockReturnValue(mockStreamInstance);

    const result = await streamMessage('Hola', onDelta);

    expect(mockStreamInstance.on).toHaveBeenCalledWith('text', onDelta);
    expect(result).toBe('respuesta en streaming');
  });

  it('llama a messages.stream con el prompt correcto', async () => {
    const mockStreamInstance = {
      on: vi.fn(),
      finalMessage: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      }),
    };
    mockStream.mockReturnValue(mockStreamInstance);

    await streamMessage('Mi prompt', vi.fn(), { maxTokens: 256, system: 'sys' });

    expect(mockStream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Mi prompt' }],
        max_tokens: 256,
        system: 'sys',
      }),
    );
  });

  it('devuelve cadena vacía si finalMessage no contiene bloque de texto', async () => {
    const mockStreamInstance = {
      on: vi.fn(),
      finalMessage: vi.fn().mockResolvedValue({ content: [] }),
    };
    mockStream.mockReturnValue(mockStreamInstance);

    const result = await streamMessage('test', vi.fn());
    expect(result).toBe('');
  });
});
