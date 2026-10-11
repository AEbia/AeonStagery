/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { BootstrapContext } from '../engine/Bootstrapper';
import type { AeonStageryElectronAPI } from '../api/types/window';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { WorkspaceToolsCommand, WorkspaceToolsSnapshot } from '../ui/workspace-tools/types';
import { useWorkspaceToolsBridge } from '../ui/hooks/useWorkspaceToolsBridge';

const stores = vi.hoisted(() => ({
  editor: { filePath: '/project/main.json', selectedActionIds: { dialogue: true }, saveStatus: 'dirty', handleSave: vi.fn() },
  validation: { issues: [], errorsCount: 0, warningsCount: 0 },
  settings: { theme: 'dark' },
  select: vi.fn(),
}));

vi.mock('../ui/store/storeHooks', () => ({
  useEditorState: () => stores.editor,
  useValidationIssues: () => stores.validation,
}));
vi.mock('../ui/SettingsStore', () => ({ useSettings: () => ({ settings: stores.settings }) }));
vi.mock('../ui/context/AppContext', () => ({ useTimelineAdapter: () => ({ select: stores.select }) }));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../engine/ScriptEngine', () => ({ scriptEngine: { transformationProxies: new Map() } }));
vi.mock('../engine/CameraController', () => ({
  cameraController: { getState: () => ({ position: { x: 0, y: 0 }, zoom: 1, rotation: 0 }) },
}));

function scene(sceneId = 'scene-a'): CurrentSceneDocument {
  return { schemaVersion: SCENE_SCHEMA_VERSION, sceneId, meta: { title: 'Test', characters: [] }, statements: [] };
}

function setup(open = false) {
  const api = mockDeep<AeonStageryElectronAPI>();
  const bridge = mockDeep<NonNullable<AeonStageryElectronAPI['workspaceTools']>>();
  api.workspaceTools = bridge;
  window.aeonStageryAPI = api;
  const context = mockDeep<BootstrapContext>();
  const subscriptions = {
    request: vi.fn(), state: vi.fn(), command: vi.fn(),
  };
  bridge.getWindowState.mockResolvedValue({ open });
  bridge.open.mockResolvedValue({ success: true });
  bridge.onSnapshotRequest.mockReturnValue(subscriptions.request);
  bridge.onWindowState.mockReturnValue(subscriptions.state);
  bridge.onCommand.mockReturnValue(subscriptions.command);
  const navigation = {
    contextTab: 'script' as const,
    handleSetContextTab: vi.fn(), handleSetSidePanelView: vi.fn(),
  };
  const hook = renderHook(({ document }) => useWorkspaceToolsBridge(
    context, document, null, navigation,
  ), { initialProps: { document: scene() } });
  const command = () => {
    const calls = bridge.onCommand.mock.calls;
    return calls[calls.length - 1][0];
  };
  const send = async (input: WorkspaceToolsCommand) => {
    await act(async () => { command()(input); });
  };
  return { ...hook, bridge, context, navigation, subscriptions, send };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('useWorkspaceToolsBridge', () => {
  it('resumes snapshot and runtime publishing for an already open detached window', async () => {
    const { bridge, rerender } = setup(true);
    await waitFor(() => expect(bridge.publishSnapshot).toHaveBeenCalled());
    expect(bridge.publishSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      sceneIdentity: { sceneId: 'scene-a', filePath: '/project/main.json', projectRoot: undefined },
      rawScript: JSON.stringify(scene(), null, 2),
      selectedActionIds: ['dialogue'], saveStatus: 'dirty', activeTab: 'script', theme: 'dark',
    } satisfies Partial<WorkspaceToolsSnapshot>));
    expect(bridge.publishRuntime).toHaveBeenCalled();

    rerender({ document: scene('scene-b') });
    await waitFor(() => expect(bridge.publishSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ sceneIdentity: expect.objectContaining({ sceneId: 'scene-b' }) }),
    ));
  });

  it('rejects a draft from the previous scene and reports the matching request', async () => {
    const { context, bridge, rerender, send } = setup();
    rerender({ document: scene('scene-b') });
    await send({ type: 'apply-raw-script', requestId: 'old-draft', rawScript: '{}',
      sceneIdentity: { sceneId: 'scene-a', filePath: '/project/main.json' } });
    expect(context.services.sceneFile.loadFromRawJson).not.toHaveBeenCalled();
    expect(bridge.publishCommandResult).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'old-draft', success: false, error: '主窗口已切换到其他场景，旧草稿未应用。',
    }));
  });

  it('applies a current draft through scene loading and returns loading errors', async () => {
    const { context, bridge, send } = setup();
    context.services.sceneFile.loadFromRawJson.mockResolvedValue({ success: false, error: 'Invalid scene' });
    await send({ type: 'apply-raw-script', requestId: 'current-draft', rawScript: '{"scene":true}',
      sceneIdentity: { sceneId: 'scene-a', filePath: '/project/main.json' } });
    expect(context.services.sceneFile.loadFromRawJson).toHaveBeenCalledWith('{"scene":true}', '/project/main.json');
    expect(bridge.publishCommandResult).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'current-draft', success: false, error: 'Invalid scene',
    }));
  });

  it('selects actions through the inspector and seeks before returning', async () => {
    const { context, navigation, send } = setup();
    await send({ type: 'select-action', actionId: 'dialogue', time: 2 });
    expect(navigation.handleSetSidePanelView).toHaveBeenCalledWith('inspector');
    expect(stores.select).toHaveBeenCalledWith({ dialogue: true });
    expect(context.adapters.playback.seek).toHaveBeenCalledWith(2, true);
  });

  it('cleans up subscriptions and runtime polling on unmount', async () => {
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const { unmount, bridge, subscriptions } = setup(true);
    await waitFor(() => expect(bridge.publishRuntime).toHaveBeenCalled());
    unmount();
    expect(subscriptions.request).toHaveBeenCalled();
    expect(subscriptions.state).toHaveBeenCalled();
    expect(subscriptions.command).toHaveBeenCalled();
    expect(clearInterval).toHaveBeenCalled();
  });
});
