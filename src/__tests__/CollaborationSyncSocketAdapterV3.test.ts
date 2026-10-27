import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { CollaborationAssetStore } from '../../server/collaboration/assets';
import { CollaborationPersistence } from '../../server/collaboration/persistence';
import { createPresenceRegistryV3 } from '../../server/collaboration/presence';
import { SingleRoomCollaborationRoomV3 } from '../../server/collaboration/room';
import { CollaborationSyncSocketAdapterV3 } from '../../server/collaboration/syncSocketAdapter';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import type { CharacterPerformanceParams } from '../api/types/semantic-scene';
import { SCENE_SCHEMA_VERSION_V5 } from '../api/types/semantic-scene';
import {
  writeCollaborativeStateV3ToYDoc,
} from '../services/collaboration/CollaborativeYDocStore';

type MessageHandler = (data: Buffer, isBinary: boolean) => void;
type CloseHandler = () => void;
type PongHandler = () => void;

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  sent: unknown[] = [];
  respondToPings = true;
  private messageHandler: MessageHandler | null = null;
  private closeHandler: CloseHandler | null = null;
  private pongHandler: PongHandler | null = null;

  send = vi.fn((data: unknown) => {
    this.sent.push(data);
  });

  ping = vi.fn(() => {
    if (this.respondToPings) this.pongHandler?.();
  });

  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emitClose();
  });

  on(event: 'message' | 'close' | 'pong', handler: MessageHandler | CloseHandler | PongHandler): void {
    if (event === 'message') this.messageHandler = handler as MessageHandler;
    if (event === 'close') this.closeHandler = handler as CloseHandler;
    if (event === 'pong') this.pongHandler = handler as PongHandler;
  }

  emitMessage(data: Uint8Array | string, isBinary: boolean): void {
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    this.messageHandler?.(payload, isBinary);
  }

  emitClose(): void {
    this.closeHandler?.();
  }
}

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

function makeStateV3(time = 1): CollaborativeSceneStateV3 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId: 'project_1',
    roomId: 'project_1:main',
    sceneId: 'scene_v3',
    meta: { title: 'Seeded Scene V3', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        time,
        type: 'dialogue',
        params: {
          text: 'Hello',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
  };
}

function makeInvalidCustomMotionState(): CollaborativeSceneStateV3 {
  return {
    ...makeStateV3(),
    statementsById: {
      motion_1: {
        id: 'motion_1',
        time: 0,
        type: 'characterPerformance',
        params: {
          target: 'alice',
          motion: {
            kind: 'custom',
            durationSeconds: 1,
            fadeInSeconds: 0,
            derivedFrom: { key: 'wave' },
            tracks: [{
              parameterId: 'PARAM_ANGLE_X',
              keyframes: [
                { time: 0, value: 0, segment: { type: 'linear' } },
                { time: 0, value: 1 },
              ],
            }],
          },
        } satisfies CharacterPerformanceParams,
      },
    },
    statementOrder: ['motion_1'],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('CollaborationSyncSocketAdapterV3', () => {
  let tempDir: string;
  let room: SingleRoomCollaborationRoomV3;
  let assets: CollaborationAssetStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aeonstagery-collab-sync-v3-'));
    const persistence = new CollaborationPersistence(tempDir);
    room = new SingleRoomCollaborationRoomV3(persistence);
    assets = new CollaborationAssetStore(tempDir);
    await assets.ensure();
    await room.seed(makeStateV3());
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('applies valid v3 binary updates and broadcasts them to other sockets', async () => {
    const clients = new Set<WebSocket>();
    const adapter = new CollaborationSyncSocketAdapterV3({
      clients,
      room,
      assets,
      presence: createPresenceRegistryV3<WebSocket>(),
    });
    const sender = new FakeSocket();
    const receiver = new FakeSocket();

    adapter.connect(asWebSocket(sender), '/sync?clientId=sender&displayName=Sender', 'localhost');
    adapter.connect(asWebSocket(receiver), '/sync?clientId=receiver&displayName=Receiver', 'localhost');
    const receiverSentBefore = receiver.sent.length;

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, room.encodeStateAsUpdate());
    const stateVector = Y.encodeStateVector(clientDoc);
    writeCollaborativeStateV3ToYDoc(clientDoc, makeStateV3(3), 'local');
    sender.emitMessage(Y.encodeStateAsUpdate(clientDoc, stateVector), true);
    await waitFor(() => receiver.sent.slice(receiverSentBefore).some((message) => Buffer.isBuffer(message)));

    expect(room.getState()?.statementsById.line_1.time).toBe(3);
    const newReceiverMessages = receiver.sent.slice(receiverSentBefore);
    expect(newReceiverMessages.some((message) => Buffer.isBuffer(message))).toBe(true);
    expect(sender.sent.some((message) => (
      typeof message === 'string' && message.includes('collaboration:error')
    ))).toBe(false);
  });

  it('measures websocket ping and broadcasts the latency as peer presence', () => {
    const clients = new Set<WebSocket>();
    const presence = createPresenceRegistryV3<WebSocket>();
    const adapter = new CollaborationSyncSocketAdapterV3({ clients, room, assets, presence });
    const socket = new FakeSocket();

    adapter.connect(asWebSocket(socket), '/sync?clientId=sender&displayName=Sender', 'localhost');

    expect(socket.ping).toHaveBeenCalled();
    const pingMs = presence.peersBySocket.get(asWebSocket(socket))?.pingMs;
    expect(pingMs).toBeGreaterThanOrEqual(0);
    expect(socket.sent.some((message) => (
      typeof message === 'string' && message.includes(`"pingMs":${pingMs}`)
    ))).toBe(true);
  });

  it('terminates a socket that misses the pong deadline', () => {
    vi.useFakeTimers();
    try {
      const clients = new Set<WebSocket>();
      const adapter = new CollaborationSyncSocketAdapterV3({
        clients,
        room,
        assets,
        presence: createPresenceRegistryV3<WebSocket>(),
      });
      const socket = new FakeSocket();
      socket.respondToPings = false;
      adapter.connect(asWebSocket(socket), '/sync?clientId=stalled&displayName=Stalled', 'localhost');

      vi.advanceTimersByTime(9000);

      expect(socket.terminate).toHaveBeenCalledOnce();
      expect(clients.has(asWebSocket(socket))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects updates with a legacy schema marker without broadcasting or mutating the v3 room', async () => {
    const clients = new Set<WebSocket>();
    const adapter = new CollaborationSyncSocketAdapterV3({
      clients,
      room,
      assets,
      presence: createPresenceRegistryV3<WebSocket>(),
    });
    const sender = new FakeSocket();
    const receiver = new FakeSocket();

    adapter.connect(asWebSocket(sender), '/sync?clientId=sender&displayName=Sender', 'localhost');
    adapter.connect(asWebSocket(receiver), '/sync?clientId=receiver&displayName=Receiver', 'localhost');
    const receiverSentBefore = receiver.sent.length;

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, room.encodeStateAsUpdate());
    const stateVector = Y.encodeStateVector(clientDoc);
    clientDoc.getMap<unknown>('collaborativeScene').set('schemaVersion', 1);
    sender.emitMessage(Y.encodeStateAsUpdate(clientDoc, stateVector), true);
    await waitFor(() => sender.sent.some((message) => (
      typeof message === 'string' &&
      message.includes('collaboration:error') &&
      message.includes('schema version 3')
    )));

    expect(room.getState()?.sceneId).toBe('scene_v3');
    expect(room.getState()?.statementsById.line_1.time).toBe(1);
    expect(receiver.sent.slice(receiverSentBefore).some((message) => Buffer.isBuffer(message))).toBe(false);
    expect(sender.sent.some((message) => (
      typeof message === 'string' &&
      message.includes('collaboration:error') &&
      message.includes('schema version 3')
    ))).toBe(true);
  });

  it('rejects invalid custom motion keyframe updates before persistence and broadcast', async () => {
    const clients = new Set<WebSocket>();
    const adapter = new CollaborationSyncSocketAdapterV3({
      clients,
      room,
      assets,
      presence: createPresenceRegistryV3<WebSocket>(),
    });
    const sender = new FakeSocket();
    const receiver = new FakeSocket();
    adapter.connect(asWebSocket(sender), '/sync?clientId=sender&displayName=Sender', 'localhost');
    adapter.connect(asWebSocket(receiver), '/sync?clientId=receiver&displayName=Receiver', 'localhost');
    const receiverSentBefore = receiver.sent.length;

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, room.encodeStateAsUpdate());
    const stateVector = Y.encodeStateVector(clientDoc);
    writeCollaborativeStateV3ToYDoc(clientDoc, makeInvalidCustomMotionState(), 'local');
    sender.emitMessage(Y.encodeStateAsUpdate(clientDoc, stateVector), true);
    await waitFor(() => sender.sent.some((message) => (
      typeof message === 'string' && message.includes('collaboration:error')
    )));

    expect(room.getMaterializedSceneDocument()?.statements[0]?.id).toBe('line_1');
    expect(receiver.sent.slice(receiverSentBefore).some((message) => Buffer.isBuffer(message))).toBe(false);
    expect(sender.sent.some((message) => (
      typeof message === 'string' && message.includes('strictly increasing')
    ))).toBe(true);
  });
});
