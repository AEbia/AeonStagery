import { describe, expect, it, vi } from 'vitest';
import {
  COLLABORATION_SCHEMA_VERSION_V3,
  type CollaborativeSceneStateV3,
} from '../api/types/collaboration';
import {
  SCENE_SCHEMA_VERSION_V4,
  SCENE_SCHEMA_VERSION_V5,
  type SceneDocumentV5,
} from '../api/types/semantic-scene';
import { CollaborativeDocumentLayerV3 } from '../services/collaboration/CollaborativeDocumentLayerV3';

function makeDocV5(): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'scene_layer_v5',
    meta: {
      title: 'Layer Test V5',
      fps: 60,
    },
    statements: [
      {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          text: 'Hello Layer V5',
          durationSeconds: 2,
        },
      },
    ],
  };
}

function makeStateV3(): CollaborativeSceneStateV3 {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION_V3,
    sceneSchemaVersion: SCENE_SCHEMA_VERSION_V5,
    collaborationProjectId: 'proj_v3',
    roomId: 'proj_v3:main',
    sceneId: 'scene_layer_v3',
    meta: { title: 'Layer Scene V3', fps: 60 },
    statementsById: {
      line_1: {
        id: 'line_1',
        type: 'dialogue',
        time: 1,
        params: {
          text: 'Hello Layer V5',
          durationSeconds: 2,
        },
      },
    },
    statementOrder: ['line_1'],
  };
}

describe('CollaborativeDocumentLayerV3', () => {
  it('connects and seeds empty room with canonical SceneDocumentV5', async () => {
    let serverState: CollaborativeSceneStateV3 | null = null;
    const clientStub = {
      join: vi.fn(async () => serverState),
      seed: vi.fn(async (state: CollaborativeSceneStateV3) => {
        serverState = state;
      }),
      getState: vi.fn(() => serverState),
      publishState: vi.fn(async (state: CollaborativeSceneStateV3) => {
        serverState = state;
      }),
      subscribe: vi.fn(() => () => {}),
      subscribeRealtimeConnection: vi.fn((listener: (c: boolean) => void) => {
        listener(true);
        return () => {};
      }),
      subscribeErrors: vi.fn(() => () => {}),
      connectRealtime: vi.fn(async () => {}),
      isRealtimeConnected: vi.fn(() => true),
      dispose: vi.fn(),
    };

    const docV5 = makeDocV5();
    const appliedDocs: SceneDocumentV5[] = [];

    const layer = new CollaborativeDocumentLayerV3({
      client: clientStub as any,
      collaborationProjectId: 'proj_v3',
      roomId: 'proj_v3:main',
      getSceneDocument: () => docV5,
      applyDocument: async (doc) => {
        appliedDocs.push(doc);
      },
    });

    await layer.connect();

    expect(clientStub.join).toHaveBeenCalled();
    expect(clientStub.seed).toHaveBeenCalled();
    expect(serverState).not.toBeNull();
    expect((serverState as any)?.schemaVersion).toBe(COLLABORATION_SCHEMA_VERSION_V3);
    expect((serverState as any)?.sceneSchemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);
    expect(layer.getStatus()).toBe('connected');

    layer.dispose();
    expect(layer.getStatus()).toBe('disconnected');
  });

  it('subscribes to realtime status with the client receiver', async () => {
    let serverState: CollaborativeSceneStateV3 | null = null;
    const clientStub: any = {
      join: vi.fn(async () => makeStateV3()),
      getState: vi.fn(() => serverState),
      subscribe: vi.fn(() => () => {}),
      subscribeErrors: vi.fn(() => () => {}),
      connectRealtime: vi.fn(),
      isRealtimeConnected: vi.fn(() => false),
      dispose: vi.fn(),
    };
    clientStub.subscribeRealtimeStatus = function subscribeRealtimeStatus(
      this: typeof clientStub,
      _listener: (status: string) => void,
    ) {
      this.statusSubscriptionInstalled = true;
      return () => {};
    };

    const layer = new CollaborativeDocumentLayerV3({
      client: clientStub,
      collaborationProjectId: 'proj_v3',
      roomId: 'proj_v3:main',
      getSceneDocument: () => makeDocV5(),
      applyDocument: async () => {},
    });

    await layer.connect();

    expect(clientStub.statusSubscriptionInstalled).toBe(true);
    layer.dispose();
  });

  it('rejects seeding if local scene is not canonical v5', async () => {
    const clientStub = {
      join: vi.fn(async () => null),
      seed: vi.fn(),
      getState: vi.fn(() => null),
      subscribe: vi.fn(() => () => {}),
      dispose: vi.fn(),
    };

    const legacyV4Doc: any = {
      schemaVersion: SCENE_SCHEMA_VERSION_V4,
      sceneId: 'legacy_v4',
      meta: { title: 'Legacy' },
      statements: [],
    };

    const layer = new CollaborativeDocumentLayerV3({
      client: clientStub as any,
      collaborationProjectId: 'proj_v3',
      roomId: 'proj_v3:main',
      getSceneDocument: () => legacyV4Doc,
      applyDocument: async () => {},
    });

    await expect(layer.connect()).rejects.toThrow(/canonical scene v5|scene schema version/i);
    expect(layer.getStatus()).toBe('error');
    layer.dispose();
  });

  it('synchronizes remote v5 updates and applies canonical v5 document', async () => {
    const clientStub = {
      join: vi.fn(async () => makeStateV3()),
      seed: vi.fn(),
      getState: vi.fn(() => makeStateV3()),
      publishState: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeRealtimeConnection: vi.fn((listener: (c: boolean) => void) => {
        listener(true);
        return () => {};
      }),
      connectRealtime: vi.fn(async () => {}),
      isRealtimeConnected: vi.fn(() => true),
      dispose: vi.fn(),
    };

    const appliedDocs: SceneDocumentV5[] = [];
    const layer = new CollaborativeDocumentLayerV3({
      client: clientStub as any,
      collaborationProjectId: 'proj_v3',
      roomId: 'proj_v3:main',
      getSceneDocument: () => makeDocV5(),
      applyDocument: async (doc) => {
        appliedDocs.push(doc);
      },
    });

    await layer.connect();
    expect(appliedDocs.length).toBeGreaterThan(0);
    expect(appliedDocs[0].schemaVersion).toBe(SCENE_SCHEMA_VERSION_V5);

    layer.dispose();
  });
});
