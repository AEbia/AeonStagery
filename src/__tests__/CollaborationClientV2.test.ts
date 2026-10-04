import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  COLLABORATION_SCHEMA_VERSION_V2,
  type CollaborativeSceneStateV2,
} from '../api/types/collaboration';
import { SCENE_SCHEMA_VERSION_V4 } from '../api/types/semantic-scene';
import { CollaborationClientV2 } from '../services/collaboration/CollaborationClientV2';
import type { CollaborationWebSocketLike } from '../services/collaboration/CollaborationTransport';
import {
  writeCollaborativeStateV2ToYDoc,
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

function makeServerUpdate(state = makeState()): Uint8Array {
  const doc = new Y.Doc();
  writeCollaborativeStateV2ToYDoc(doc, state, 'server');
  return Y.encodeStateAsUpdate(doc);
}

describe('CollaborationClientV2', () => {
  it('reports upload progress through the fetch fallback', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 })) as typeof fetch;
    const client = new CollaborationClientV2({
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
    const client = new CollaborationClientV2({
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

  it('joins by applying v2 Yjs state from the server', async () => {
    const fetchImpl = vi.fn(async () => (
      new Response(toArrayBuffer(makeServerUpdate(makeState(2))), { status: 200 })
    )) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: vi.fn() as any,
    });
    const states: Array<CollaborativeSceneStateV2 | null> = [];
    client.subscribe((state) => states.push(state));

    const state = await client.join();

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:12345/yjs-state');
    expect(state?.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V2);
    expect(state?.statementsById.line_1.time).toBe(2);
    expect(states.at(-1)?.statementsById.line_1.time).toBe(2);
  });

  it('seeds v2 state through HTTP and then applies server Yjs state', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/seed')) {
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return new Response(toArrayBuffer(makeServerUpdate(makeState(3))), { status: 200 });
    }) as typeof fetch;
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: vi.fn() as any,
    });

    await client.seed(makeState(3));

    expect(calls[0].url).toBe('http://127.0.0.1:12345/seed');
    expect(JSON.parse(calls[0].init?.body as string).schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V2);
    expect(client.getState()?.statementsById.line_1.time).toBe(3);
  });

  it('publishes statement and companion changes into the local v2 doc and realtime socket', async () => {
    const ydoc = new Y.Doc();
    writeCollaborativeStateV2ToYDoc(ydoc, makeState(), 'seed');
    const socket = createSocketStub();
    const client = new CollaborationClientV2({
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
            text: 'Changed',
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

  it('sends and receives only v2 presence messages', async () => {
    const socket = createSocketStub();
    const client = new CollaborationClientV2({
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
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      selectedStatementIds: ['line_1'],
      editingTarget: { kind: 'companion', statementId: 'line_1', companionId: 'focus' },
      playheadTime: 2,
    }));

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        peer: {
          clientId: 'peer-1',
          displayName: 'Rana',
          selectedStatementIds: ['line_1'],
          editingTarget: { kind: 'statement', statementId: 'line_1' },
        },
      }),
    } as MessageEvent);
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'presence:update',
        peer: {
          clientId: 'legacy-peer',
          displayName: 'Legacy',
          selectedActionIds: ['a1'],
          editingTarget: { kind: 'action', id: 'a1' },
        },
      }),
    } as MessageEvent);

    expect(presenceMessages).toEqual([
      {
        type: 'presence:update',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        peer: {
          clientId: 'peer-1',
          displayName: 'Rana',
          selectedStatementIds: ['line_1'],
          editingTarget: { kind: 'statement', statementId: 'line_1' },
        },
      },
    ]);
  });

  it('delivers a presence snapshot received immediately after realtime opens', async () => {
    const socket = createSocketStub();
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl: vi.fn() as any,
      webSocketFactory: () => socket,
      identity: { clientId: 'self-1', displayName: '导演' },
    });
    const presenceMessages: unknown[] = [];
    client.subscribePresence((message) => presenceMessages.push(message));

    client.connectRealtime();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'presence:snapshot',
        schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
        peers: [{
          clientId: 'peer-1',
          displayName: 'Rana',
          selectedStatementIds: [],
          editingTarget: null,
          playheadTime: 3.5,
        }],
      }),
    } as MessageEvent);

    expect(presenceMessages).toEqual([{
      type: 'presence:snapshot',
      schemaVersion: COLLABORATION_SCHEMA_VERSION_V2,
      peers: [{
        clientId: 'peer-1',
        displayName: 'Rana',
        selectedStatementIds: [],
        editingTarget: null,
        playheadTime: 3.5,
      }],
    }]);
  });

  it('resyncs v2 server state after a collaboration error frame', async () => {
    const ydoc = new Y.Doc();
    writeCollaborativeStateV2ToYDoc(ydoc, makeState(1), 'seed');
    const fetchImpl = vi.fn(async () => (
      new Response(toArrayBuffer(makeServerUpdate(makeState(5))), { status: 200 })
    )) as typeof fetch;
    const socket = createSocketStub();
    const client = new CollaborationClientV2({
      endpoint: '127.0.0.1:12345',
      fetchImpl,
      webSocketFactory: () => socket,
      ydoc,
    });
    const errors: string[] = [];
    client.subscribeErrors((error) => errors.push(error.message));

    client.connectRealtime();
    await vi.waitFor(() => expect(client.isRealtimeConnected()).toBe(true));
    await client.publishState(makeState(9));
    expect(client.getState()?.statementsById.line_1.time).toBe(9);

    socket.onmessage?.({
      data: JSON.stringify({ type: 'collaboration:error', message: 'Rejected v2 update' }),
    } as MessageEvent);
    await vi.waitFor(() => {
      expect(client.getState()?.statementsById.line_1.time).toBe(5);
    });

    expect(errors).toEqual(['Rejected v2 update']);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:12345/yjs-state');
    expect(client.isRealtimeConnected()).toBe(true);
  });
});
