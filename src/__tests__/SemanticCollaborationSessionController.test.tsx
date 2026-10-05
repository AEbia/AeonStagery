/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollaborationPresencePatchV2, CollaborationPresencePeerV2 } from '../api/types/collaboration';
import type { BootstrapContext } from '../engine/Bootstrapper';
import type { ProjectState } from '../api/types/project';
import {
  useSemanticCollaborationSession,
} from '../ui/useSemanticCollaborationSession';

const mocks = vi.hoisted(() => {
  const state = {
    selectedActionIds: new Set<string>(),
    clients: [] as Array<Record<string, any>>,
    layers: [] as Array<Record<string, any>>,
    gates: [] as Array<Record<string, any>>,
    presenceUnsubscribes: [] as Array<ReturnType<typeof vi.fn>>,
    resourceAgreements: [] as Array<Record<string, any>>,
    serverSceneAgreements: [] as Array<Record<string, any>>,
  };

  class FakeClient {
    endpoint: string;
    updatePresence = vi.fn();
    dispose = vi.fn();
    acquireLease = vi.fn();
    renewLease = vi.fn();
    releaseLease = vi.fn();
    reconnectRealtime = vi.fn();

    constructor(options: { endpoint: string }) {
      this.endpoint = options.endpoint;
      state.clients.push(this);
    }

    subscribePresence = vi.fn((_listener: unknown) => {
      const unsubscribe = vi.fn();
      state.presenceUnsubscribes.push(unsubscribe);
      return unsubscribe;
    });

    subscribeLease = vi.fn((_listener: unknown) => {
      return vi.fn();
    });
  }

  // Options are recorded so tests can drive the orchestrator callbacks the
  // session hook passes in (for example beforeApplyState).
  const orchestratorStart = vi.fn(async (_options?: any) => {
    const layer = {
      dispose: vi.fn(),
      publishCurrentSceneNow: vi.fn(async () => undefined),
    };
    state.layers.push(layer);
    return layer;
  });

  class FakeOrchestrator {
    start = orchestratorStart;
  }

  class FakeGate {
    cancelActiveTransfer = vi.fn();
    reset = vi.fn();
    prepareLocalPublishV3 = vi.fn(async (input: { document: unknown }) => ({
      document: input.document,
      assets: {},
    }));
    prepareLocalPublishV5 = vi.fn(async (input: { document: unknown }) => ({
      document: input.document,
      assets: {},
    }));
    buildAgreementProposal = vi.fn(async () => undefined);
    prepareRemoteApply = vi.fn(async () => undefined);

    constructor() {
      state.gates.push(this);
    }
  }

  class FakeResourceAgreement {
    cancelPending = vi.fn();
    complete = vi.fn();

    constructor() {
      state.resourceAgreements.push(this);
    }
  }

  class FakeServerSceneAgreement {
    hasAcceptedServerScene = false;
    reset = vi.fn();
    complete = vi.fn();
    request = vi.fn(async () => undefined);
    commitAcceptedServerDocument = vi.fn(async () => undefined);
    options: any;

    constructor(options?: any) {
      this.options = options;
      state.serverSceneAgreements.push(this);
    }
  }

  return {
    state,
    FakeClient,
    FakeOrchestrator,
    orchestratorStart,
    FakeGate,
    FakeResourceAgreement,
    FakeServerSceneAgreement,
    showToast: vi.fn(),
  };
});

vi.mock('../ui/store/storeHooks', () => ({
  useEditorSelection: () => ({ selectedActionIds: mocks.state.selectedActionIds }),
}));

vi.mock('../ui/Toast', () => ({
  showToast: mocks.showToast,
}));

vi.mock('../services/collaboration/CollaborationClientV3', () => ({
  CollaborationClientV3: mocks.FakeClient,
}));

vi.mock('../services/collaboration/CollaborativeSessionOrchestratorV3', () => ({
  CollaborativeSessionOrchestratorV3: mocks.FakeOrchestrator,
}));

vi.mock('../services/collaboration/CollaborativeAssetReadinessGate', () => ({
  CollaborativeAssetReadinessGate: mocks.FakeGate,
}));

vi.mock('../services/collaboration/CollaborativeAssetManifestBuilder', () => ({
  CollaborativeAssetManifestBuilder: class {},
}));

vi.mock('../services/collaboration/CollaborativeAssetUploader', () => ({
  CollaborativeAssetUploader: class {},
}));

vi.mock('../services/collaboration/CollaborativeAssetDownloader', () => ({
  CollaborativeAssetDownloader: class {},
}));

vi.mock('../services/collaboration/CollaborativeAgreementAdapters', () => ({
  CollaborativeResourceAgreementAdapter: mocks.FakeResourceAgreement,
  CollaborativeServerSceneAgreementAdapterV3: mocks.FakeServerSceneAgreement,
  CollaborativeServerSceneSafetyPathAdapterV3: class {},
}));

type PlaybackHarness = {
  adapter: {
    getCurrentTime: ReturnType<typeof vi.fn>;
    subscribeTime: ReturnType<typeof vi.fn>;
  };
  emitTime: (time: number) => void;
};

function createPlaybackHarness(initialTime = 0): PlaybackHarness {
  let currentTime = initialTime;
  const listeners = new Set<(time: number) => void>();
  const adapter = {
    getCurrentTime: vi.fn(() => currentTime),
    subscribeTime: vi.fn((listener: (time: number) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    adapter,
    emitTime: (time: number) => {
      currentTime = time;
      listeners.forEach((listener) => listener(time));
    },
  };
}

function makeValidSceneV5(): Record<string, unknown> {
  return {
    schemaVersion: 5,
    sceneId: 'scene-1',
    meta: { title: 'Main Scene', fps: 60 },
    statements: [
      {
        id: 'statement-1',
        time: 1,
        type: 'dialogue',
        params: { text: 'Hello', durationSeconds: 2 },
      },
    ],
  };
}

function createContext(playback: PlaybackHarness, sceneOverride?: unknown): BootstrapContext {
  const scene = sceneOverride !== undefined ? sceneOverride : makeValidSceneV5();
  return {
    adapters: { playback: playback.adapter },
    stores: {
      document: {
        getCompiledSceneSnapshot: () => ({
          actions: [
            { id: 'action-1', source: { statementId: 'statement-1' } },
            { id: 'action-2', source: { statementId: 'statement-2', companionId: 'companion-2' } },
          ],
        }),
        getCurrentSceneDocumentSnapshot: () => scene,
        getSceneDocumentV5Snapshot: () => scene,
      },
      editor: { _setSaveStatus: vi.fn() },
    },
    services: {
      fileAccess: { writeFile: vi.fn(async () => undefined) },
      projectResources: { resolveForProjectWrite: vi.fn(async (p: string) => `/project/${p}`) },
      sceneAssets: {},
      sceneFile: { saveCurrentSceneDocument: vi.fn(async () => ({ success: true })) },
      semanticDocument: {},
    },
    dispose: vi.fn(),
  } as unknown as BootstrapContext;
}

function createProject(): ProjectState {
  return {
    rootPath: '/project',
    projectFilePath: '/project/project.json',
    metadata: {
      projectId: 'project-1',
      name: 'Test project',
      projectVersion: 2,
      createdAt: '',
      updatedAt: '',
      defaultSceneId: 'scene-1',
      scenes: [{ id: 'scene-1', name: 'Main', path: 'project/main.scene.json' }],
      assetRoots: {},
    },
  } as ProjectState;
}

function renderController(input: {
  status?: 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'offline' | 'seeding' | 'error';
  currentProject?: ProjectState | null;
  playback?: PlaybackHarness;
  context?: BootstrapContext;
  onLeaseGateChange?: (gate: unknown) => void;
  collaborationServerStatus?: any;
} = {}) {
  const playback = input.playback ?? createPlaybackHarness();
  const context = input.context ?? createContext(playback);
  let status = input.status ?? 'disconnected';
  const callbacks = {
    onStatusChange: vi.fn(),
    onSelfChange: vi.fn(),
    onPeersChange: vi.fn(),
    onPresencePublisherChange: vi.fn(),
    onLeaseGateChange: input.onLeaseGateChange ?? vi.fn(),
  };
  const hook = renderHook(() => useSemanticCollaborationSession({
    contextValue: context,
    currentProject: input.currentProject ?? null,
    status,
    peers: [] as CollaborationPresencePeerV2[],
    collaborationServerStatus: input.collaborationServerStatus,
    ...callbacks,
  }));
  return {
    ...hook,
    ...callbacks,
    playback,
    rerenderWithStatus: (nextStatus: typeof status) => {
      status = nextStatus;
      hook.rerender();
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.state.selectedActionIds = new Set();
  mocks.state.clients.length = 0;
  mocks.state.layers.length = 0;
  mocks.state.gates.length = 0;
  mocks.state.presenceUnsubscribes.length = 0;
  mocks.state.resourceAgreements.length = 0;
  mocks.state.serverSceneAgreements.length = 0;
  mocks.orchestratorStart.mockClear();
  mocks.showToast.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('semantic collaboration session controller', () => {
  it('loads stored inputs and persists changes through public setters', () => {
    window.localStorage.setItem('aeonstagery.collaboration.endpoint', 'stored.example:9000');
    window.localStorage.setItem('aeonstagery.collaboration.displayName', 'Stored director');

    const { result } = renderController();

    expect(result.current.endpoint).toBe('stored.example:9000');
    expect(result.current.displayName).toBe('Stored director');

    act(() => {
      result.current.setEndpoint('updated.example:9100');
      result.current.setDisplayName('Updated director');
    });

    expect(result.current.endpoint).toBe('updated.example:9100');
    expect(result.current.displayName).toBe('Updated director');
    expect(window.localStorage.getItem('aeonstagery.collaboration.endpoint'))
      .toBe('updated.example:9100');
    expect(window.localStorage.getItem('aeonstagery.collaboration.displayName'))
      .toBe('Updated director');
  });

  it('uses the controller defaults when stored inputs are absent', () => {
    const { result } = renderController();

    expect(result.current.endpoint).toBe('127.0.0.1:12345');
    expect(result.current.displayName).toBe('导演');
  });

  it('rejects an empty endpoint before creating a session', async () => {
    const { result, onStatusChange } = renderController({ currentProject: createProject() });
    let started = true;

    await act(async () => {
      started = await result.current.hostCurrentScene({ endpoint: '   ' });
    });

    expect(started).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith('请输入协作服务器 IP 和端口', 'warning');
    expect(mocks.state.clients).toHaveLength(0);
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('rejects a start request when no project is selected', async () => {
    const { result, onStatusChange } = renderController();
    let started = true;

    await act(async () => {
      started = await result.current.hostCurrentScene({ endpoint: 'server.example:1234' });
    });

    expect(started).toBe(false);
    expect(mocks.showToast).toHaveBeenCalledWith('请先创建或打开一个项目', 'warning');
    expect(mocks.state.clients).toHaveLength(0);
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('rejects a start request when semantic collaboration capabilities are incomplete', async () => {
    const playback = createPlaybackHarness();
    const completeContext = createContext(playback);
    const incompleteContext = {
      ...completeContext,
      services: { ...completeContext.services, projectResources: undefined },
    } as unknown as BootstrapContext;
    const { result, onStatusChange } = renderController({
      context: incompleteContext,
      currentProject: createProject(),
      playback,
    });
    let started = true;

    await act(async () => {
      started = await result.current.hostCurrentScene({ endpoint: 'server.example:1234' });
    });

    expect(started).toBe(false);
    expect(mocks.showToast)
      .toHaveBeenCalledWith('当前运行环境缺少语义场景或协作素材能力', 'error');
    expect(mocks.state.clients).toHaveLength(0);
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('exposes connected flags and clears the presence publisher when disconnected', () => {
    const controller = renderController({ status: 'connected' });

    expect(controller.result.current.isConnected).toBe(true);
    expect(controller.result.current.isOffline).toBe(false);
    expect(controller.result.current.isBusy).toBe(false);
    expect(controller.onPresencePublisherChange).toHaveBeenLastCalledWith(expect.any(Function));

    act(() => controller.rerenderWithStatus('disconnected'));

    expect(controller.result.current.isConnected).toBe(false);
    expect(controller.result.current.isOffline).toBe(false);
    expect(controller.onPresencePublisherChange).toHaveBeenLastCalledWith(null);
  });

  it('retries the active realtime connection without starting another room session', async () => {
    const controller = renderController({ currentProject: createProject() });

    await act(async () => {
      expect(await controller.result.current.hostCurrentScene({
        endpoint: 'server.example:1234',
      })).toBe(true);
    });

    const client = mocks.state.clients[0];
    act(() => controller.result.current.retryConnection());

    expect(client.reconnectRealtime).toHaveBeenCalledOnce();
    expect(mocks.orchestratorStart).toHaveBeenCalledOnce();
  });

  it('publishes selected semantic statement ids and the current playhead', async () => {
    mocks.state.selectedActionIds = new Set(['action-1', 'action-2']);
    const playback = createPlaybackHarness(1.24);
    const controller = renderController({
      currentProject: createProject(),
      playback,
    });

    await act(async () => {
      expect(await controller.result.current.hostCurrentScene({
        endpoint: 'server.example:1234',
      })).toBe(true);
    });
    act(() => controller.rerenderWithStatus('connected'));

    const client = mocks.state.clients[0];
    client.updatePresence.mockClear();
    const publisher = controller.onPresencePublisherChange.mock.calls
      .at(-1)?.[0] as (patch?: Partial<CollaborationPresencePatchV2>) => void;

    act(() => publisher());

    expect(client.updatePresence).toHaveBeenLastCalledWith({
      selectedStatementIds: ['statement-1', 'statement-2'],
      editingTarget: null,
      playheadTime: 1.24,
    });
  });

  it('normalizes and throttles playhead updates from the playback boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const playback = createPlaybackHarness(1);
    const controller = renderController({
      currentProject: createProject(),
      playback,
    });

    await act(async () => {
      expect(await controller.result.current.hostCurrentScene({
        endpoint: 'server.example:1234',
      })).toBe(true);
    });
    act(() => controller.rerenderWithStatus('connected'));

    const client = mocks.state.clients[0];
    client.updatePresence.mockClear();

    act(() => playback.emitTime(2.34));
    expect(client.updatePresence).toHaveBeenCalledTimes(1);
    expect(client.updatePresence).toHaveBeenLastCalledWith(expect.objectContaining({
      playheadTime: 2.3,
    }));

    act(() => playback.emitTime(2.34));
    expect(client.updatePresence).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2000);
    act(() => playback.emitTime(2.34));
    expect(client.updatePresence).toHaveBeenCalledTimes(2);
    expect(client.updatePresence).toHaveBeenLastCalledWith(expect.objectContaining({
      playheadTime: 2.3,
    }));
  });

  it('disconnects by clearing state, notifying parents, and disposing resources', async () => {
    const controller = renderController({ currentProject: createProject() });

    await act(async () => {
      expect(await controller.result.current.hostCurrentScene({
        endpoint: 'server.example:1234',
      })).toBe(true);
    });
    act(() => controller.rerenderWithStatus('connected'));

    const layer = mocks.state.layers[0];
    const resourceAgreement = mocks.state.resourceAgreements[0];
    const serverSceneAgreement = mocks.state.serverSceneAgreements[0];
    const gate = mocks.state.gates[0];
    controller.onStatusChange.mockClear();
    controller.onSelfChange.mockClear();
    controller.onPeersChange.mockClear();
    controller.onPresencePublisherChange.mockClear();

    act(() => controller.result.current.disconnect());

    expect(controller.result.current.selfIdentity).toBeNull();
    expect(controller.result.current.resourceAgreement).toBeNull();
    expect(controller.result.current.lastResourceAgreementProposal).toBeNull();
    expect(controller.result.current.serverSceneAgreement).toBeNull();
    expect(controller.result.current.lastError).toBeNull();
    expect(layer.dispose).toHaveBeenCalledOnce();
    expect(mocks.state.presenceUnsubscribes[0]).toHaveBeenCalledOnce();
    expect(gate.cancelActiveTransfer).toHaveBeenCalledOnce();
    expect(resourceAgreement.cancelPending).toHaveBeenCalledOnce();
    expect(serverSceneAgreement.reset).toHaveBeenCalledOnce();
    expect(controller.onSelfChange).toHaveBeenLastCalledWith(null);
    expect(controller.onPeersChange).toHaveBeenLastCalledWith([]);
    expect(controller.onPresencePublisherChange).toHaveBeenLastCalledWith(null);
    expect(controller.onStatusChange).toHaveBeenLastCalledWith('disconnected');

    act(() => controller.rerenderWithStatus('disconnected'));
    expect(controller.result.current.isConnected).toBe(false);
    expect(controller.result.current.isOffline).toBe(false);
  });

  it('cleans active collaboration resources when unmounted', async () => {
    const controller = renderController({ currentProject: createProject() });

    await act(async () => {
      expect(await controller.result.current.hostCurrentScene({
        endpoint: 'server.example:1234',
      })).toBe(true);
    });
    act(() => controller.rerenderWithStatus('connected'));

    const client = mocks.state.clients[0];
    const layer = mocks.state.layers[0];
    const unsubscribe = mocks.state.presenceUnsubscribes[0];

    controller.unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(layer.dispose).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(controller.onPresencePublisherChange).toHaveBeenLastCalledWith(null);
  });

  describe('canonical v5 collaboration admission', () => {
    it('rejects starting collaboration when local scene is legacy schema version 4 without mutating local state', async () => {
      const playback = createPlaybackHarness();
      const legacyDoc = {
        schemaVersion: 4,
        sceneId: 'legacy-scene',
        meta: { title: 'Legacy Scene' },
        statements: [],
      };
      const context = createContext(playback, legacyDoc);
      const controller = renderController({
        context,
        currentProject: createProject(),
        playback,
      });

      let success = true;
      await act(async () => {
        success = await controller.result.current.hostCurrentScene({ endpoint: 'server.example:1234' });
      });

      expect(success).toBe(false);
      expect(controller.result.current.lastError).toMatch(/unsupported_schema_version|4/i);
      expect(mocks.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/无法进入协作/i),
        'error',
      );
      expect(mocks.state.clients).toHaveLength(0);
      expect(context.services.fileAccess.writeFile).not.toHaveBeenCalled();
    });

    it('rejects starting collaboration when local scene contains unknown fields without mutating local facts', async () => {
      const playback = createPlaybackHarness();
      const docWithUnknownFields = {
        ...makeValidSceneV5(),
        extraUnsupportedField: 'polluted',
      };
      const context = createContext(playback, docWithUnknownFields);
      const controller = renderController({
        context,
        currentProject: createProject(),
        playback,
      });

      let success = true;
      await act(async () => {
        success = await controller.result.current.hostCurrentScene({ endpoint: 'server.example:1234' });
      });

      expect(success).toBe(false);
      expect(controller.result.current.lastError).toMatch(/unknown_fields_present|extraUnsupportedField/i);
      expect(mocks.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/无法进入协作/i),
        'error',
      );
      expect(mocks.state.clients).toHaveLength(0);
      expect(context.services.fileAccess.writeFile).not.toHaveBeenCalled();
    });

    it('rejects starting collaboration when local scene contains unknown statement discriminator', async () => {
      const playback = createPlaybackHarness();
      const docWithUnknownStmt = {
        schemaVersion: 5,
        sceneId: 'scene-1',
        meta: { title: 'Main Scene', fps: 60 },
        statements: [
          {
            id: 'stmt-unknown',
            time: 1,
            type: 'unsupported_future_action_type',
            params: {},
          },
        ],
      };
      const context = createContext(playback, docWithUnknownStmt);
      const controller = renderController({
        context,
        currentProject: createProject(),
        playback,
      });

      let success = true;
      await act(async () => {
        success = await controller.result.current.hostCurrentScene({ endpoint: 'server.example:1234' });
      });

      expect(success).toBe(false);
      expect(controller.result.current.lastError).toMatch(/unknown_discriminator|unsupported_future_action_type/i);
      expect(mocks.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/无法进入协作/i),
        'error',
      );
      expect(mocks.state.clients).toHaveLength(0);
    });

    it('rejects starting collaboration when local scene is malformed', async () => {
      const playback = createPlaybackHarness();
      const malformedDoc = {
        schemaVersion: 5,
        sceneId: 'scene-1',
        meta: { title: 'Main Scene' },
        statements: 'not-an-array',
      };
      const context = createContext(playback, malformedDoc);
      const controller = renderController({
        context,
        currentProject: createProject(),
        playback,
      });

      let success = true;
      await act(async () => {
        success = await controller.result.current.hostCurrentScene({ endpoint: 'server.example:1234' });
      });

      expect(success).toBe(false);
      expect(controller.result.current.lastError).toMatch(/statements|array/i);
      expect(mocks.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/无法进入协作/i),
        'error',
      );
      expect(mocks.state.clients).toHaveLength(0);
    });
  });

  describe('custom motion edit lease gate integration', () => {
    it('initializes and provides the lease gate during connection and cleans it up on disconnect', async () => {
      const onLeaseGateChange = vi.fn();
      const controller = renderController({
        currentProject: createProject(),
        onLeaseGateChange,
      });

      await act(async () => {
        expect(await controller.result.current.hostCurrentScene({
          endpoint: 'server.example:1234',
        })).toBe(true);
      });

      expect(onLeaseGateChange).toHaveBeenCalledWith(expect.objectContaining({
        acquire: expect.any(Function),
        release: expect.any(Function),
      }));

      act(() => controller.result.current.disconnect());

      expect(onLeaseGateChange).toHaveBeenLastCalledWith(null);
    });
  });

  describe('server version incompatibility and connection failure', () => {
    it('reports failure and sets lastError when server orchestrator rejects connection', async () => {
      const playback = createPlaybackHarness();
      const context = createContext(playback);
      const controller = renderController({
        context,
        currentProject: createProject(),
        playback,
      });

      mocks.orchestratorStart.mockRejectedValueOnce(
        new Error('Server returned unsupported collaboration schema version 2; expected version 3'),
      );

      let success = true;
      await act(async () => {
        success = await controller.result.current.joinExistingRoom({ endpoint: 'legacy-server.example:1234' });
      });

      expect(success).toBe(false);
      expect(controller.result.current.lastError).toMatch(/schema version 2|expected version 3/i);
      expect(mocks.showToast).toHaveBeenCalledWith(
        expect.stringMatching(/协作连接失败: Server returned unsupported collaboration schema version 2/i),
        'error',
      );
      expect(controller.onStatusChange).toHaveBeenLastCalledWith('error');
    });
  });

  describe('skip server scene agreement dialog for server host', () => {
    it('passes skipDialog: true and suppresses agreement dialog when joining as server host explicitly', async () => {
      const controller = renderController({ currentProject: createProject() });

      let success = false;
      await act(async () => {
        success = await controller.result.current.joinExistingRoom({
          endpoint: 'server.example:1234',
          isServerHost: true,
        });
      });

      expect(success).toBe(true);
      const orchestratorOptions = mocks.orchestratorStart.mock.calls[0]?.[0];
      expect(orchestratorOptions).toBeDefined();

      const serverSceneAgreement = mocks.state.serverSceneAgreements[0];
      expect(serverSceneAgreement).toBeDefined();

      // Trigger beforeApplyState
      const mockState = {
        schemaVersion: 3,
        sceneSchemaVersion: 5,
        collaborationProjectId: 'proj-1',
        roomId: 'proj-1:main',
        sceneId: 'main',
        statementsById: {},
        statementOrder: [],
      };
      await orchestratorOptions.beforeApplyState(mockState, {
        requireServerSceneAgreement: true,
        prepareAssets: true,
      });

      expect(serverSceneAgreement.request).toHaveBeenCalledWith(
        mockState,
        expect.objectContaining({
          skipDialog: true,
        }),
      );
      // Dialog state in controller remains null (no popup shown)
      expect(controller.result.current.serverSceneAgreement).toBeNull();
    });

    it('automatically recognizes matching local collaboration server status and skips dialog', async () => {
      const controller = renderController({
        currentProject: createProject(),
        collaborationServerStatus: {
          running: true,
          port: 12345,
          localUrl: 'http://127.0.0.1:12345',
          lanUrls: ['http://192.168.1.100:12345'],
          host: '0.0.0.0',
        },
      });

      let success = false;
      await act(async () => {
        success = await controller.result.current.joinExistingRoom({
          endpoint: '127.0.0.1:12345',
        });
      });

      expect(success).toBe(true);
      const orchestratorOptions = mocks.orchestratorStart.mock.calls[0]?.[0];
      const serverSceneAgreement = mocks.state.serverSceneAgreements[0];

      const mockState = {
        schemaVersion: 3,
        sceneSchemaVersion: 5,
        collaborationProjectId: 'proj-1',
        roomId: 'proj-1:main',
        sceneId: 'main',
        statementsById: {},
        statementOrder: [],
      };
      await orchestratorOptions.beforeApplyState(mockState, {
        requireServerSceneAgreement: true,
        prepareAssets: true,
      });

      expect(serverSceneAgreement.request).toHaveBeenCalledWith(
        mockState,
        expect.objectContaining({
          skipDialog: true,
        }),
      );
      expect(controller.result.current.serverSceneAgreement).toBeNull();
    });

    it('does not skip dialog when joining a non-host server', async () => {
      const controller = renderController({
        currentProject: createProject(),
        collaborationServerStatus: {
          running: true,
          port: 12345,
          localUrl: 'http://127.0.0.1:12345',
          lanUrls: ['http://192.168.1.100:12345'],
          host: '0.0.0.0',
        },
      });

      let success = false;
      await act(async () => {
        success = await controller.result.current.joinExistingRoom({
          endpoint: '192.168.1.200:12345', // Different machine IP
        });
      });

      expect(success).toBe(true);
      const orchestratorOptions = mocks.orchestratorStart.mock.calls[0]?.[0];
      const serverSceneAgreement = mocks.state.serverSceneAgreements[0];

      const mockState = {
        schemaVersion: 3,
        sceneSchemaVersion: 5,
        collaborationProjectId: 'proj-1',
        roomId: 'proj-1:main',
        sceneId: 'main',
        statementsById: {},
        statementOrder: [],
      };
      await orchestratorOptions.beforeApplyState(mockState, {
        requireServerSceneAgreement: true,
        prepareAssets: true,
      });

      expect(serverSceneAgreement.request).toHaveBeenCalledWith(
        mockState,
        expect.objectContaining({
          skipDialog: false,
        }),
      );
      // When presenter.show is triggered on non-host, controller receives the dialog state
      act(() => {
        serverSceneAgreement.options.presenter.show({
          targetScenePath: '/test/main.scene.json',
        });
      });
      expect(controller.result.current.serverSceneAgreement).not.toBeNull();
    });
  });
});
