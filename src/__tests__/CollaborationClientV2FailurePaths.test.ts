import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V4 } from '../api/types/semantic-scene';
import { CollaborationClientV2 } from '../services/collaboration/CollaborationClientV2';
import type { CollaborationWebSocketLike } from '../services/collaboration/CollaborationTransport';
import { writeCollaborativeStateV2ToYDoc } from '../services/collaboration/CollaborativeYDocStore';

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

function makeState(time = 1): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v2',
    meta: { title: 'Client V2 Scene', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        type: 'dialogue',
        time,
        params: {
          text: 'Hello',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
    companionGroupsByStatementId: {
      line_1: {
        companionsById: {
          focus: {
            id: 'focus',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '$speaker',
            },
          },
        },
        companionOrder: ['focus'],
      },
    },
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function makeServerUpdate(state = makeState()): Uint8Array {
  const doc = new Y.Doc();
  writeCollaborativeStateV2ToYDoc(doc, state, 'server');
  return Y.encodeStateAsUpdate(doc);
}

describe('CollaborationClientV2 failure paths', () => {
  it('reports the HTTP status when joining fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => createSocketStub(),
    });

    await expect(client.join()).rejects.toThrow('Failed to join collaboration room: HTTP 503');
  });

  it('preserves the server error message when seeding fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: 'Room is already seeded' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => createSocketStub(),
    });

    await expect(client.seed(makeState())).rejects.toThrow('Room is already seeded');
  });

  it('reports a useful network failure when the seed POST cannot reach the server', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => createSocketStub(),
    });

    await expect(client.seed(makeState())).rejects.toThrow(
      'Failed to seed collaboration room at http://127.0.0.1:12345: connection refused. '
      + 'Check that the tunnel forwards plain HTTP traffic to the host collaboration port.',
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/seed',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports a useful network failure when joining cannot reach the server', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => createSocketStub(),
    });

    await expect(client.join()).rejects.toThrow(
      'Failed to join collaboration room at http://127.0.0.1:12345: connection refused. '
      + 'Check that the tunnel forwards plain HTTP traffic to the host collaboration port.',
    );
  });

  it('reports a useful network failure when reseeding cannot fetch server state', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/seed')) return new Response(null, { status: 201 });
      throw new Error('connection refused');
    }) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => createSocketStub(),
    });

    await expect(client.seed(makeState())).rejects.toThrow(
      'Failed to seed collaboration room at http://127.0.0.1:12345: connection refused. '
      + 'Check that the tunnel forwards plain HTTP traffic to the host collaboration port.',
    );
  });

  it('reports upload HTTP failure without emitting a completion progress event', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 502 })) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => createSocketStub(),
    });
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];

    await expect(client.uploadAssetFile('background/bg.png', new Uint8Array([1, 2, 3]), {
      totalBytes: 5,
      onProgress: (next) => progress.push(next),
    })).rejects.toThrow('Failed to upload collaborative asset "background/bg.png": HTTP 502');

    expect(progress).toEqual([{ loadedBytes: 0, totalBytes: 5 }]);
  });

  it('reports download HTTP failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => createSocketStub(),
    });

    await expect(client.downloadAssetFile('background/bg.png')).rejects.toThrow(
      'Failed to download collaborative asset "background/bg.png": HTTP 404',
    );
  });

  it('returns an empty byte array and progress for a successful response without a body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => createSocketStub(),
    });
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];

    const bytes = await client.downloadAssetFile('background/bg.png', {
      totalBytes: 4,
      onProgress: (next) => progress.push(next),
    });

    expect(bytes).toEqual(new Uint8Array());
    expect(progress).toEqual([
      { loadedBytes: 0, totalBytes: 4 },
      { loadedBytes: 0, totalBytes: 4 },
    ]);
  });

  it('aborts a streamed download through the provided signal', async () => {
    const abortController = new AbortController();
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(streamController) {
        streamController.enqueue(encoder.encode('a'));
      },
    }), { status: 200 })) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => createSocketStub(),
    });

    await expect(client.downloadAssetFile('background/bg.png', {
      signal: abortController.signal,
      onProgress: (next) => {
        if (next.loadedBytes === 1) abortController.abort();
      },
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:12345/assets/background/bg.png', {
      signal: abortController.signal,
    });
  });

  it('rejects state transactions before a room has been joined', async () => {
    const socket = createSocketStub();
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl: vi.fn() as typeof fetch,
      webSocketFactory: () => socket,
    });

    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));

    expect(() => client.transactState((state) => state)).toThrow(
      'Cannot transact collaborative state before joining or seeding',
    );
    client.dispose();
  });

  it('preserves a replacement state returned by a transaction mutator', async () => {
    const serverState = makeState(2);
    const fetchImpl = vi.fn(async () => new Response(
      toArrayBuffer(makeServerUpdate(serverState)),
      { status: 200 },
    )) as typeof fetch;
    const socket = createSocketStub();
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => socket,
    });
    const replacementState = makeState(8);

    await client.join();
    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));

    const returnedState = client.transactState(() => replacementState);

    expect(returnedState).toEqual(replacementState);
    expect(client.getState()?.statementsById.line_1.time).toBe(8);
    client.dispose();
  });

  it('stops future notifications when individual subscription disposers are called', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      toArrayBuffer(makeServerUpdate()),
      { status: 200 },
    )) as typeof fetch;
    const socket = createSocketStub();
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => socket,
    });
    const states: unknown[] = [];
    const presenceMessages: unknown[] = [];
    const connections: boolean[] = [];
    const errors: string[] = [];

    const disposeStateSubscription = client.subscribe((state) => states.push(state));
    disposeStateSubscription();
    await client.join();
    expect(states).toEqual([]);

    const disposeConnectionSubscription = client.subscribeRealtimeConnection((isConnected) => {
      connections.push(isConnected);
    });
    disposeConnectionSubscription();
    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));
    expect(connections).toEqual([]);

    const disposePresenceSubscription = client.subscribePresence((message) => presenceMessages.push(message));
    disposePresenceSubscription();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        peer: {
          clientId: 'peer-1',
          displayName: 'Peer',
          selectedStatementIds: [],
          editingTarget: null,
        },
      }),
    } as MessageEvent);
    expect(presenceMessages).toEqual([]);

    const disposeErrorSubscription = client.subscribeErrors((error) => errors.push(error.message));
    disposeErrorSubscription();
    socket.onmessage?.({
      data: JSON.stringify({ type: 'collaboration:error', message: 'Rejected update' }),
    } as MessageEvent);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(errors).toEqual([]);
    client.dispose();
  });

  it('stops state, presence, connection, and error notifications after dispose', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      toArrayBuffer(makeServerUpdate()),
      { status: 200 },
    )) as typeof fetch;
    const socket = createSocketStub();
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => socket,
    });
    const states: unknown[] = [];
    const presenceMessages: unknown[] = [];
    const connections: boolean[] = [];
    const errors: string[] = [];
    client.subscribe((state) => states.push(state));
    client.subscribePresence((message) => presenceMessages.push(message));
    client.subscribeRealtimeConnection((isConnected) => connections.push(isConnected));
    client.subscribeErrors((error) => errors.push(error.message));

    await client.join();
    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        peer: {
          clientId: 'peer-1',
          displayName: 'Peer',
          selectedStatementIds: [],
          editingTarget: null,
        },
      }),
    } as MessageEvent);
    socket.onmessage?.({
      data: JSON.stringify({ type: 'collaboration:error', message: 'Rejected update' }),
    } as MessageEvent);
    await vi.waitFor(() => expect(errors).toEqual(['Rejected update']));
    expect(states.length).toBeGreaterThan(0);
    expect(presenceMessages).toHaveLength(1);
    expect(connections).toContain(true);

    states.length = 0;
    presenceMessages.length = 0;
    connections.length = 0;
    errors.length = 0;
    client.dispose();

    await client.join();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        peer: {
          clientId: 'peer-2',
          displayName: 'Peer 2',
          selectedStatementIds: [],
          editingTarget: null,
        },
      }),
    } as MessageEvent);
    socket.onmessage?.({
      data: JSON.stringify({ type: 'collaboration:error', message: 'Rejected after dispose' }),
    } as MessageEvent);
    socket.onopen?.();
    socket.onclose?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(states).toEqual([]);
    expect(presenceMessages).toEqual([]);
    expect(connections).toEqual([]);
    expect(errors).toEqual([]);
  });
});
