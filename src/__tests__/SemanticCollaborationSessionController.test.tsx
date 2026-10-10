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
    missingLeaseMethods: false,
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
      if (state.missingLeaseMethods) this.subscribeLease = undefined as any;
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

  const orchestratorStart = vi.fn(async () => {
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

    constructor() {
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
      customMotionEditing: {
        closeActive: vi.fn(async () => undefined),
        replaceAuthority: vi.fn(async () => undefined),
      },
      customMotionConversion: { cancel: vi.fn(async () => undefined) },
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
} = {}) {
  const playback = input.playback ?? createPlaybackHarness();
  const context = input.context ?? createContext(playback);
  let status = input.status ?? 'disconnected';
  const callbacks = {
    onStatusChange: vi.fn(),
    onSelfChange: vi.fn(),
    onPeersChange: vi.fn(),
    onPresencePublisherChange: vi.fn(),
  };
  const hook = renderHook(() => useSemanticCollaborationSession({
    contextValue: context,
    currentProject: input.currentProject ?? null,
    status,
    peers: [] as CollaborationPresencePeerV2[],
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
  mocks.state.missingLeaseMethods = false;
  mocks.state.clients.length = 0;
  mocks.state.layers.length = 0;
  mocks.state.gates.length = 0;
  mocks.state.presenceUnsubscribes.length = 0;
  mocks.state.resourceAgreements.length = 0;
  mocks.state.serverSceneAgreements.length = 0;
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

    await act(async () => { await controller.result.current.disconnect(); });

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

    await act(async () => { controller.unmount(); });

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

  describe('custom motion authority integration', () => {
    it('injects production authorization and returns to singleplayer after draining edits', async () => {
      const context = createContext(createPlaybackHarness());
      const controller = renderController({ currentProject: createProject(), context });
      await act(async () => {
        expect(await controller.result.current.hostCurrentScene()).toBe(true);
      });
      const editing = context.services.customMotionEditing;
      expect(editing.replaceAuthority).toHaveBeenLastCalledWith(expect.objectContaining({
        acquire: expect.any(Function), release: expect.any(Function), onLoss: expect.any(Function),
      }));
      const authority = vi.mocked(editing.replaceAuthority).mock.calls.at(-1)![0];
      const client = mocks.state.clients[0];
      const decision = authority.acquire({ kind: 'statement', statementId: 'statement-1' }, new AbortController().signal);
      expect(client.acquireLease).toHaveBeenCalledOnce();
      await act(async () => { await controller.result.current.disconnect(); });
      // The real module disposes the adapter after draining. This lightweight
      // editing fixture only records injection, so finish its pending request here.
      authority.dispose();
      await decision;
      expect(editing.closeActive).toHaveBeenCalledWith('authority-changed');
      expect(context.services.customMotionConversion.cancel).toHaveBeenCalled();
      expect(client.dispose).toHaveBeenCalledOnce();
    });

    it('invalidates and cancels synchronously but waits for entered writes before disposing transports', async () => {
      const context = createContext(createPlaybackHarness());
      const controller = renderController({ currentProject: createProject(), context });
      await act(async () => { await controller.result.current.hostCurrentScene(); });
      let finishWrite!: () => void;
      const enteredWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
      vi.mocked(context.services.customMotionEditing.closeActive).mockReturnValueOnce(enteredWrite);
      const client = mocks.state.clients[0];
      const layer = mocks.state.layers[0];
      let cleanupTask!: Promise<void>;
      act(() => { cleanupTask = controller.result.current.disconnect(); });
      expect(context.services.customMotionEditing.closeActive).toHaveBeenLastCalledWith('authority-changed');
      expect(context.services.customMotionConversion.cancel).toHaveBeenCalled();
      expect(client.dispose).not.toHaveBeenCalled();
      expect(layer.dispose).not.toHaveBeenCalled();
      await act(async () => { finishWrite(); await cleanupTask; });
      expect(layer.dispose).toHaveBeenCalledOnce();
      expect(client.dispose).toHaveBeenCalledOnce();
    });

    it('does not start a room when its client lacks lease authorization', async () => {
      mocks.state.missingLeaseMethods = true;
      const context = createContext(createPlaybackHarness());
      const controller = renderController({ currentProject: createProject(), context });
      const previousStarts = mocks.orchestratorStart.mock.calls.length;
      await act(async () => { expect(await controller.result.current.hostCurrentScene()).toBe(false); });
      expect(mocks.orchestratorStart.mock.calls).toHaveLength(previousStarts);
      expect(controller.result.current.lastError).toBe('协作客户端缺少自定义动作租约能力');
      expect(mocks.state.clients[0].dispose).toHaveBeenCalledOnce();
      expect(context.services.customMotionEditing.replaceAuthority).toHaveBeenCalledTimes(2);
    });

    it('drains an entered write before disposing a transport on unmount', async () => {
      const context = createContext(createPlaybackHarness());
      const controller = renderController({ currentProject: createProject(), context });
      await act(async () => { await controller.result.current.hostCurrentScene(); });
      let finishWrite!: () => void;
      vi.mocked(context.services.customMotionEditing.closeActive).mockReturnValueOnce(new Promise((resolve) => { finishWrite = resolve; }));
      const client = mocks.state.clients[0];
      controller.unmount();
      expect(context.services.customMotionConversion.cancel).toHaveBeenCalled();
      expect(client.dispose).not.toHaveBeenCalled();
      await act(async () => { finishWrite(); });
      expect(client.dispose).toHaveBeenCalledOnce();
    });

    it('ignores an old connection failure after a newer connection has succeeded', async () => {
      const controller = renderController({ currentProject: createProject() });
      let failOld!: (error: Error) => void;
      mocks.orchestratorStart.mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject; }));
      let oldStart!: Promise<boolean>;
      await act(async () => { oldStart = controller.result.current.hostCurrentScene(); });
      await act(async () => { expect(await controller.result.current.hostCurrentScene()).toBe(true); });
      const newClient = mocks.state.clients[1];
      controller.onStatusChange.mockClear();
      await act(async () => { failOld(new Error('old connection failed')); expect(await oldStart).toBe(false); });
      expect(controller.onStatusChange).not.toHaveBeenCalledWith('error');
      expect(controller.result.current.lastError).toBeNull();
      expect(newClient.dispose).not.toHaveBeenCalled();
    });

    it('waits for draining edits before disposing a layer returned after disconnect', async () => {
      const context = createContext(createPlaybackHarness());
      const controller = renderController({ currentProject: createProject(), context });
      let finishStart!: (layer: any) => void;
      const layer = { dispose: vi.fn() };
      mocks.orchestratorStart.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }));
      let starting!: Promise<boolean>;
      await act(async () => { starting = controller.result.current.hostCurrentScene(); });
      let finishWrite!: () => void;
      vi.mocked(context.services.customMotionEditing.closeActive).mockReturnValueOnce(new Promise((resolve) => { finishWrite = resolve; }));
      let disconnecting!: Promise<void>;
      act(() => { disconnecting = controller.result.current.disconnect(); });
      await act(async () => { finishStart(layer); });
      expect(layer.dispose).not.toHaveBeenCalled();
      await act(async () => { finishWrite(); await disconnecting; expect(await starting).toBe(false); });
      expect(layer.dispose).toHaveBeenCalledOnce();
    });

    it('prevents an old late connection from replacing or disposing the new session', async () => {
      const controller = renderController({ currentProject: createProject() });
      let finishOld!: (layer: any) => void;
      const oldLayer = { dispose: vi.fn(), publishCurrentSceneNow: vi.fn() };
      mocks.orchestratorStart.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
      let oldStart!: Promise<boolean>;
      await act(async () => { oldStart = controller.result.current.hostCurrentScene(); });
      const oldClient = mocks.state.clients[0];
      await act(async () => {
        expect(await controller.result.current.hostCurrentScene({ endpoint: 'new.example:1234' })).toBe(true);
      });
      const newClient = mocks.state.clients[1];
      const newLayer = mocks.state.layers[0];
      await act(async () => { finishOld(oldLayer); expect(await oldStart).toBe(false); });
      expect(oldLayer.dispose).toHaveBeenCalledOnce();
      expect(oldClient.dispose).toHaveBeenCalledOnce();
      expect(newLayer.dispose).not.toHaveBeenCalled();
      expect(newClient.dispose).not.toHaveBeenCalled();
      await act(async () => { await controller.result.current.disconnect(); });
      expect(newLayer.dispose).toHaveBeenCalledOnce();
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
});
