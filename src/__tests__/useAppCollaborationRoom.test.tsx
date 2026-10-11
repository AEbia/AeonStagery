/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { BootstrapContext } from '../engine/Bootstrapper';
import type { AeonStageryElectronAPI } from '../api/types/window';
import type { CollaborationServerStatus } from '../api/types/collaboration';
import type { ProjectState } from '../api/types/project';
import type { SemanticCollaborationSessionController } from '../ui/useSemanticCollaborationSession';
import { useAppCollaborationRoom } from '../ui/hooks/useAppCollaborationRoom';
import { useAppCollaborationState } from '../ui/hooks/useAppCollaborationState';

const session = vi.hoisted(() => ({ useSession: vi.fn() }));
vi.mock('../ui/useSemanticCollaborationSession', () => ({ useSemanticCollaborationSession: session.useSession }));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

const hostInput = { name: 'Project', rootPath: '/project', displayName: 'Host', port: 4010 };
const joinInput = { rootPath: '/project', displayName: 'Guest', endpoint: 'http://remote:4010' };

function setup({ admitted = true, reused = false } = {}) {
  const api = mockDeep<AeonStageryElectronAPI>();
  window.aeonStageryAPI = api;
  const context = mockDeep<BootstrapContext>();
  const controller = mockDeep<SemanticCollaborationSessionController>();
  controller.sessionCredentials = null;
  controller.hostCurrentScene.mockResolvedValue(admitted);
  controller.joinExistingRoom.mockResolvedValue(admitted);
  session.useSession.mockReturnValue(controller);
  const currentProject = mockDeep<ProjectState>();
  currentProject.metadata.projectId = 'project-a';
  const workflow = {
    success: true, outcome: 'project_ready', failureKind: null, messageKey: 'project_ready',
    project: currentProject, scenePath: '/project/main.json',
  } as const;
  context.services.projectOpenWorkflow.createProjectAndLoadDefaultScene.mockResolvedValue(workflow);
  context.services.projectOpenWorkflow.prepareCollaborationJoinProject.mockResolvedValue(workflow);
  context.services.sceneFile.loadFromPath.mockResolvedValue({ success: true, path: '/project/main.json', issues: [] });
  const status: CollaborationServerStatus = {
    running: true, host: '0.0.0.0', port: 4010, dataDir: '/server', localUrl: 'http://127.0.0.1:4010',
    lanUrls: [], assetRoot: '/assets', hasState: false, accessToken: 'test-token',
  };
  api.collaborationServer.getStatus.mockResolvedValue({ success: true, status });
  api.collaborationServer.start.mockResolvedValue({ success: true, status, reused });
  api.collaborationServer.stop.mockResolvedValue({ success: true });
  const project = {
    currentProject, showProjectWorkflowResult: vi.fn(), setIsCollaborationJoinHomeLocked: vi.fn(),
  };
  const hook = renderHook(() => {
    const { sessionBindings } = useAppCollaborationState();
    return useAppCollaborationRoom(context, sessionBindings, project);
  });
  return { ...hook, api, context, controller, project };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('useAppCollaborationRoom', () => {
  it('unlocks the homepage only after hosting succeeds and retains server room state', async () => {
    const { result, project, controller } = setup();
    await act(async () => { await result.current.handleHostNewCollaboration(hostInput); });
    expect(controller.hostCurrentScene).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'Host', project: project.currentProject, isServerHost: true,
    }));
    expect(project.setIsCollaborationJoinHomeLocked.mock.calls).toEqual([[true], [false]]);
    expect(result.current.collaborationServerStatus?.hasState).toBe(true);
  });

  it('stops a fresh empty server on failed admission while leaving the homepage locked for retry', async () => {
    const { result, api, project } = setup({ admitted: false });
    await act(async () => { await result.current.handleHostNewCollaboration(hostInput); });
    expect(api.collaborationServer.stop).toHaveBeenCalledOnce();
    expect(project.setIsCollaborationJoinHomeLocked.mock.calls).toEqual([[true]]);
    expect(result.current.collaborationServerStatus).toBeNull();
  });

  it('preserves a reused server after failed admission', async () => {
    const { result, api } = setup({ admitted: false, reused: true });
    await act(async () => { await result.current.handleHostNewCollaboration(hostInput); });
    expect(api.collaborationServer.stop).not.toHaveBeenCalled();
    expect(result.current.collaborationServerStatus?.running).toBe(true);
  });

  it('does not join a room when the prepared local scene cannot load', async () => {
    const { result, context, controller, project } = setup();
    context.services.sceneFile.loadFromPath.mockResolvedValue({ success: false, error: 'Invalid scene' });
    await act(async () => { await result.current.handleJoinCollaboration(joinInput); });
    expect(controller.joinExistingRoom).not.toHaveBeenCalled();
    expect(project.setIsCollaborationJoinHomeLocked.mock.calls).toEqual([[true]]);
  });

  it('loads the local scene before joining and unlocks after admission', async () => {
    const { result, context, controller, project } = setup();
    await act(async () => { await result.current.handleJoinCollaboration(joinInput); });
    expect(context.services.sceneFile.loadFromPath).toHaveBeenCalledWith('/project/main.json');
    expect(controller.joinExistingRoom).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: joinInput.endpoint, project: project.currentProject, isServerHost: false,
    }));
    expect(context.services.sceneFile.loadFromPath.mock.invocationCallOrder[0]).toBeLessThan(
      controller.joinExistingRoom.mock.invocationCallOrder[0],
    );
    expect(project.setIsCollaborationJoinHomeLocked.mock.calls).toEqual([[true], [false]]);
  });
});
