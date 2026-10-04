import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV2,
  type CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
} from '../api/types/semantic-scene';
import { CollaborationClientV3 } from '../services/collaboration/CollaborationClientV3';
import type { CollaborationWebSocketLike } from '../services/collaboration/CollaborationTransport';
import {
  writeCollaborativeStateV2ToYDoc,
  writeCollaborativeStateV3ToYDoc,
} from '../services/collaboration/CollaborativeYDocStore';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

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

function makeStateV3(time = 1): CollaborativeSceneStateV3 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId: 'project_v3',
    roomId: 'project_v3:main',
    sceneId: 'scene_v3',
    meta: { title: 'Client V3 Scene', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        type: 'dialogue',
        time,
        params: {
          text: 'Hello from v3',
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

function makeStateV2(time = 1): CollaborativeSceneStateV2 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V4,
    collaborationProjectId: 'project_v2',
    roomId: 'project_v2:main',
    sceneId: 'scene_v2',
    meta: { title: 'Client V2 Scene', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        type: 'dialogue',
        time,
        params: {
          text: 'Hello from v2',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
  };
}

function makeServerUpdateV3(state = makeStateV3()): Uint8Array {
  const doc = new Y.Doc();
  writeCollaborativeStateV3ToYDoc(doc, state, 'server');
  return Y.encodeStateAsUpdate(doc);
}

function makeServerUpdateV2(state = makeStateV2()): Uint8Array {
  const doc = new Y.Doc();
  writeCollaborativeStateV2ToYDoc(doc, state, 'server');
  return Y.encodeStateAsUpdate(doc);
}

describe('CollaborationClientV3', () => {
  it('reports upload progress through fetch fallback', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 })) as typeof fetch;
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: vi.fn() as any,
    });
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];

    await client.uploadAssetFile('background/bg.png', new TextEncoder().encode('bg'), {
      totalBytes: 2,
      onProgress: (next) => progress.push(next),
    });

    expect(progress).toEqual([
      { loadedBytes: 0, totalBytes: 2 },
      { loadedBytes: 2, totalBytes: 2 },
    ]);
  });

  it('reports streamed download progress while reading the server response', async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('a'));
        controller.enqueue(encoder.encode('bc'));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-length': '3' },
    })) as typeof fetch;
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: vi.fn() as any,
    });
    const progress: Array<{ loadedBytes: number; totalBytes: number }> = [];

    const bytes = await client.downloadAssetFile('background/bg.png', {
      totalBytes: 3,
      onProgress: (next) => progress.push(next),
    });

    expect(new TextDecoder().decode(bytes)).toBe('abc');
    expect(progress[0]).toEqual({ loadedBytes: 0, totalBytes: 3 });
    expect(progress.some((next) => next.loadedBytes === 1 && next.totalBytes === 3)).toBe(true);
    expect(progress.at(-1)).toEqual({ loadedBytes: 3, totalBytes: 3 });
  });

  it('joins by applying v3 Yjs state from the server', async () => {
    const fetchImpl = vi.fn(async () => (
      new Response(toArrayBuffer(makeServerUpdateV3(makeStateV3(2))), { status: 200 })
    )) as typeof fetch;
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: vi.fn() as any,
    });
    const states: Array<CollaborativeSceneStateV3 | null> = [];
    client.subscribe((state) => {
      states.push(state);
    });

    const state = await client.join();

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:12345/yjs-state');
    expect(state?.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V3);
    expect(state?.sceneSchemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(state?.statementsById.line_1.time).toBe(2);
    expect(states.at(-1)?.statementsById.line_1.time).toBe(2);
  });

  it('does not re-emit the current state when rejecting remote state', async () => {
    const fetchImpl = vi.fn(async () => (
      new Response(toArrayBuffer(makeServerUpdateV3()), { status: 200 })
    )) as typeof fetch;
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: vi.fn() as any,
    });
    await client.join();
    const stateListener = vi.fn();
    client.subscribe(stateListener);

    client.rejectRemoteState(new Error('invalid remote scene'));

    expect(stateListener).not.toHaveBeenCalled();
    client.dispose();
  });

  it('rejects joining if server returns v2 protocol or scene v4 state without modifying local state', async () => {
    const fetchImpl = vi.fn(async () => (
      new Response(toArrayBuffer(makeServerUpdateV2(makeStateV2(2))), { status: 200 })
    )) as typeof fetch;
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: vi.fn() as any,
    });

    await expect(client.join()).rejects.toThrow(/schema version 3|scene schema version 5/i);
    expect(client.getState()).toBeNull();
  });

  it('seeds v3 state through HTTP and then applies server Yjs state', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/seed')) {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return new Response(toArrayBuffer(makeServerUpdateV3(makeStateV3(3))), { status: 200 });
    }) as typeof fetch;
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: vi.fn() as any,
    });

    await client.seed(makeStateV3(3));

    expect(calls[0].url).toBe('http://127.0.0.1:12345/seed');
    expect(JSON.parse(calls[0].init?.body as string).schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V3);
    expect(JSON.parse(calls[0].init?.body as string).sceneSchemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(client.getState()?.statementsById.line_1.time).toBe(3);
  });

  it('rejects seeding with v2 state or scene v4 state without making network requests or mutating doc', async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: vi.fn() as any,
    });

    await expect(client.seed(makeStateV2() as any)).rejects.toThrow(
      /Expected collaboration state schema version 3/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.getState()).toBeNull();
  });

  it('publishes statement and companion changes into the local v3 doc and realtime socket', async () => {
    const ydoc = new Y.Doc();
    writeCollaborativeStateV3ToYDoc(ydoc, makeStateV3(), 'seed');
    const socket = createSocketStub();
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl: vi.fn() as any,
      webSocketFactory: () => socket,
      ydoc,
    });

    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));

    await client.publishStatementChanges({
      upsertStatements: {
        line_1: {
          id: 'line_1',
          type: 'dialogue',
          time: 4,
          params: {
            text: 'Changed v3',
            durationSeconds: 2,
          },
        },
      },
    });
    expect(client.getState()?.statementsById.line_1.time).toBe(4);

    await client.publishCompanionChanges({
      statementId: 'line_1',
      upsertCompanions: {
        focus: {
          id: 'focus',
          anchor: 'start',
          offset: 0,
          type: 'camera',
          params: {
            mode: 'focus',
            target: '$speaker',
            durationSeconds: 1,
          },
        },
      },
    });

    expect(client.getState()?.companionGroupsByStatementId?.line_1.companionsById.focus.params)
      .toMatchObject({ durationSeconds: 1 });
    expect(socket.send).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('reconnects after a transport close and resyncs server state before becoming writable', async () => {
    vi.useFakeTimers();
    try {
      const firstSocket = createSocketStub();
      const retrySocket = createSocketStub(0);
      const sockets = [firstSocket, retrySocket];
      const fetchImpl = vi.fn(async () => new Response(
        toArrayBuffer(makeServerUpdateV3(makeStateV3(5))),
        { status: 200 },
      )) as typeof fetch;
      const client = new CollaborationClientV3({
        endpoint: '127.0.0.1:12345',
        fetchImpl,
        webSocketFactory: () => sockets.shift() ?? createSocketStub(0),
      });
      const statuses: string[] = [];
      client.subscribeRealtimeStatus((status) => statuses.push(status));

      client.connectRealtime();
      expect(client.isRealtimeConnected()).toBe(true);
      firstSocket.readyState = 3;
      firstSocket.onclose?.();
      expect(statuses.at(-1)).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(1000);
      retrySocket.readyState = 1;
      await retrySocket.onopen?.();

      expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:12345/yjs-state');
      expect(client.getState()?.statementsById.line_1.time).toBe(5);
      expect(client.isRealtimeConnected()).toBe(true);
      expect(statuses.at(-1)).toBe('connected');
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops after five automatic retries and allows an explicit retry', async () => {
    vi.useFakeTimers();
    try {
      const sockets: CollaborationWebSocketLike[] = [];
      const client = new CollaborationClientV3({
        endpoint: '127.0.0.1:12345',
        fetchImpl: vi.fn() as any,
        webSocketFactory: () => {
          const socket = createSocketStub(sockets.length === 0 ? 1 : 0);
          sockets.push(socket);
          return socket;
        },
      });
      const statuses: string[] = [];
      client.subscribeRealtimeStatus((status) => statuses.push(status));

      client.connectRealtime();
      const initialSocket = sockets[0];
      initialSocket.readyState = 3;
      initialSocket.onclose?.();
      for (const delay of [1000, 2000, 4000, 8000, 16000]) {
        await vi.advanceTimersByTimeAsync(delay);
        const socket = sockets[sockets.length - 1];
        socket.readyState = 3;
        socket.onclose?.();
      }

      expect(sockets).toHaveLength(6);
      expect(statuses.at(-1)).toBe('offline');
      await vi.advanceTimersByTimeAsync(60000);
      expect(sockets).toHaveLength(6);

      client.reconnectRealtime();
      expect(sockets).toHaveLength(7);
      expect(statuses.at(-1)).toBe('reconnecting');
      client.dispose();
      await vi.advanceTimersByTimeAsync(60000);
      expect(sockets).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not automatically retry a remote state rejected by the local schema parser', async () => {
    vi.useFakeTimers();
    try {
      const sockets: CollaborationWebSocketLike[] = [];
      const fetchImpl = vi.fn(async () => new Response(
        toArrayBuffer(makeServerUpdateV2()),
        { status: 200 },
      )) as typeof fetch;
      const client = new CollaborationClientV3({
        endpoint: '127.0.0.1:12345',
        fetchImpl,
        webSocketFactory: () => {
          const socket = createSocketStub(sockets.length === 0 ? 1 : 0);
          sockets.push(socket);
          return socket;
        },
      });
      const statuses: string[] = [];
      client.subscribeRealtimeStatus((status) => statuses.push(status));

      client.connectRealtime();
      sockets[0].readyState = 3;
      sockets[0].onclose?.();
      await vi.advanceTimersByTimeAsync(1000);
      sockets[1].readyState = 1;
      await sockets[1].onopen?.();

      expect(statuses.at(-1)).toBe('error');
      await vi.advanceTimersByTimeAsync(60000);
      expect(sockets).toHaveLength(2);

      client.reconnectRealtime();
      sockets[2].readyState = 1;
      await sockets[2].onopen?.();
      expect(statuses.at(-1)).toBe('error');
      await vi.advanceTimersByTimeAsync(60000);
      expect(sockets).toHaveLength(3);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends and receives only v3 presence messages and ignores v2 presence', async () => {
    const socket = createSocketStub();
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl: vi.fn() as any,
      webSocketFactory: () => socket,
    });
    const presenceMessages: unknown[] = [];
    client.subscribePresence((message) => presenceMessages.push(message));

    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));
    client.updatePresence({
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
      playheadTime: 2,
    });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'presence:update',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
      playheadTime: 2,
    }));

    // V3 peer presence update
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peer: {
          clientId: 'peer-1',
          displayName: 'Rana',
          selectedStatementIds: ['line_1'],
          editingTarget: { kind: 'statement', statementId: 'line_1' },
        },
      }),
    } as MessageEvent);

    // V2 peer presence update should be ignored by v3 client
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        peer: {
          clientId: 'legacy-peer',
          displayName: 'Legacy',
          selectedStatementIds: ['line_1'],
          editingTarget: { kind: 'statement', statementId: 'line_1' },
        },
      }),
    } as MessageEvent);

    expect(presenceMessages).toEqual([
      {
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        peer: {
          clientId: 'peer-1',
          displayName: 'Rana',
          selectedStatementIds: ['line_1'],
          editingTarget: { kind: 'statement', statementId: 'line_1' },
        },
      },
    ]);
  });

  it('sends and receives v3 lease messages and ignores v2 lease messages', async () => {
    const socket = createSocketStub();
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl: vi.fn() as any,
      webSocketFactory: () => socket,
    });
    const leaseMessages: unknown[] = [];
    client.subscribeLease((message) => leaseMessages.push(message));

    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));

    client.acquireLease('req-1', { kind: 'statement', statementId: 'line_1' });
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'lease:acquire',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
      requestId: 'req-1',
      target: { kind: 'statement', statementId: 'line_1' },
    }));

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'lease:acquired',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        requestId: 'req-1',
        target: { kind: 'statement', statementId: 'line_1' },
      }),
    } as MessageEvent);

    // V2 lease message should be ignored
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'lease:acquired',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        requestId: 'req-legacy',
        target: { kind: 'statement', statementId: 'line_1' },
      }),
    } as MessageEvent);

    expect(leaseMessages).toEqual([
      {
        type: 'lease:acquired',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
        requestId: 'req-1',
        target: { kind: 'statement', statementId: 'line_1' },
      },
    ]);
  });

  it('rejects incoming v2 Yjs updates on realtime channel without corrupting local doc', async () => {
    const ydoc = new Y.Doc();
    writeCollaborativeStateV3ToYDoc(ydoc, makeStateV3(1), 'seed');
    const socket = createSocketStub();
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl: vi.fn() as any,
      webSocketFactory: () => socket,
      ydoc,
    });
    const errors: string[] = [];
    client.subscribeErrors((error) => errors.push(error.message));

    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));

    // Send an update that writes v2 schema
    const v2Doc = new Y.Doc();
    writeCollaborativeStateV2ToYDoc(v2Doc, makeStateV2(99), 'remote');
    const v2Update = Y.encodeStateAsUpdate(v2Doc);

    socket.onmessage?.({ data: v2Update } as MessageEvent);

    // Verify local v3 state is uncorrupted
    expect(client.getState()?.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V3);
    expect(client.getState()?.sceneSchemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(client.getState()?.statementsById.line_1.time).toBe(1);
    expect(errors.some((e) => e.includes('schema version'))).toBe(true);
  });

  it('resyncs v3 server state after a collaboration error frame', async () => {
    const ydoc = new Y.Doc();
    writeCollaborativeStateV3ToYDoc(ydoc, makeStateV3(1), 'seed');
    const fetchImpl = vi.fn(async () => (
      new Response(toArrayBuffer(makeServerUpdateV3(makeStateV3(5))), { status: 200 })
    )) as typeof fetch;
    const socket = createSocketStub();
    const client = new CollaborationClientV3({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => socket,
      ydoc,
    });
    const errors: string[] = [];
    client.subscribeErrors((error) => errors.push(error.message));

    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));
    await client.publishState(makeStateV3(9));
    expect(client.getState()?.statementsById.line_1.time).toBe(9);

    socket.onmessage?.({
      data: JSON.stringify({ type: 'collaboration:error', message: 'Rejected v3 update' }),
    } as MessageEvent);
    await vi.waitFor(() => {
      expect(client.getState()?.statementsById.line_1.time).toBe(5);
    });

    expect(errors).toEqual(['Rejected v3 update']);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:12345/yjs-state');
    expect(client.isRealtimeConnected()).toBe(true);
  });
});
