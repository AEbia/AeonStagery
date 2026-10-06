import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationClientV2 } from '../services/collaboration/CollaborationClientV2';
import { CollaborationClientV3 } from '../services/collaboration/CollaborationClientV3';
import type { CollaborationWebSocketLike } from '../services/collaboration/CollaborationTransport';

/**
 * The client port contract: connectRealtime() resolves once the connection
 * attempt has been dispatched (or has failed) rather than after the socket has
 * opened. Callers rely on that boundary when they read the initial connection
 * status, and on errors arriving through subscribeErrors rather than rejections.
 */

const token = 'a'.repeat(43);

function createSocketStub(readyState = 1): CollaborationWebSocketLike {
  return {
    binaryType: 'blob',
    readyState,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ['CollaborationClientV2', CollaborationClientV2],
  ['CollaborationClientV3', CollaborationClientV3],
] as const)('%s realtime connect contract', (_name, Client) => {
  it('resolves once the socket is dispatched and shares one in-flight attempt', async () => {
    const socket = createSocketStub();
    const webSocketFactory = vi.fn(() => socket);
    const client = new Client({
      endpoint: '127.0.0.1:12345',
      fetchImpl: vi.fn() as any,
      webSocketFactory,
    });

    try {
      // Concurrent callers join the same attempt instead of opening two sockets.
      await Promise.all([client.connectRealtime(), client.connectRealtime()]);

      expect(webSocketFactory).toHaveBeenCalledOnce();
      expect(socket.onmessage).toBeTruthy();
      expect(client.isRealtimeConnected()).toBe(true);

      // An already connected channel short-circuits without a new socket.
      await client.connectRealtime();
      expect(webSocketFactory).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
    }
  });

  it('never rejects a failed attempt and reports it through subscribeErrors', async () => {
    const webSocketFactory = vi.fn(() => createSocketStub());
    const fetchImpl = vi.fn(async () => {
      throw new Error('challenge unavailable');
    });
    const client = new Client({
      // A remote endpoint must fetch a one-time challenge before connecting.
      endpoint: `https://collab.example#token=${token}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      webSocketFactory,
    });
    const errors: Error[] = [];
    client.subscribeErrors((error) => errors.push(error));

    try {
      await expect(client.connectRealtime()).resolves.toBeUndefined();

      expect(webSocketFactory).not.toHaveBeenCalled();
      expect(errors.map((error) => error.message)).toEqual(['challenge unavailable']);
      expect(client.isRealtimeConnected()).toBe(false);
    } finally {
      client.dispose();
    }
  });
});
