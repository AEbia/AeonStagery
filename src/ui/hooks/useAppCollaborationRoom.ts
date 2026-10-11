import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BootstrapContext } from '../../engine/Bootstrapper';
import type { CollaborationServerStatus } from '../../api/types/collaboration';
import {
  isMatchingCollaborationServerHost,
  withCollaborationAccessToken,
} from '../../services/collaboration/CollaborationTransport';
import { useSemanticCollaborationSession } from '../useSemanticCollaborationSession';
import type { CollaborationServerCredentials } from '../CollaborationConnectPanel';
import { showToast } from '../Toast';
import type { useAppCollaborationState } from './useAppCollaborationState';
import type { ProjectState } from '../../api/types/project';
import type { ProjectWorkflowResult } from '../../api/interfaces/IProjectOpenWorkflow';

export function releaseCollaborationJoinHomeLockAfterRoomCreated(
  roomCreated: boolean,
  setLocked: (locked: boolean) => void,
): void {
  if (roomCreated) {
    setLocked(false);
  }
}

/** Coordinates local server lifetime, room admission, and homepage locking. */
export function useAppCollaborationRoom(
  contextValue: BootstrapContext,
  sessionBindings: ReturnType<typeof useAppCollaborationState>['sessionBindings'],
  project: {
    currentProject: ProjectState | null;
    showProjectWorkflowResult: (result: ProjectWorkflowResult, mode: 'create' | 'open' | 'recent', notifySuccess?: boolean) => void;
    setIsCollaborationJoinHomeLocked: (locked: boolean) => void;
  },
) {
  const { currentProject, showProjectWorkflowResult, setIsCollaborationJoinHomeLocked } = project;
  const collaborationStatus = sessionBindings.status;
  const [collaborationServerStatus, setCollaborationServerStatus] = useState<CollaborationServerStatus | null>(null);
  const collaborationController = useSemanticCollaborationSession({
    contextValue, currentProject, collaborationServerStatus, ...sessionBindings,
  });
  useEffect(() => {
    const serverApi = window.aeonStageryAPI?.collaborationServer;
    if (!serverApi?.getStatus) return;
    let mounted = true;
    void serverApi.getStatus().then((result) => {
      if (mounted && result.success) setCollaborationServerStatus(result.status ?? null);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const startInternalCollaborationServer = useCallback(async (input: { projectId: string; port: number; allowNetwork?: boolean; password?: string }) => {
    const result = await window.aeonStageryAPI.collaborationServer.start({
      projectId: input.projectId,
      host: input.allowNetwork === false ? '127.0.0.1' : '0.0.0.0',
      password: input.password,
      port: input.port,
    });
    if (!result.success || !result.status) {
      throw new Error(result.error || '启动协作服务器失败');
    }
    setCollaborationServerStatus(result.status);
    return { status: result.status, reused: result.reused === true };
  }, []);

  const serverStatusToEndpoint = useCallback((status: CollaborationServerStatus, reachableUrl?: string) => {
    try {
      return withCollaborationAccessToken(new URL(reachableUrl ?? status.localUrl).origin, status.accessToken);
    } catch {
      return withCollaborationAccessToken(`http://127.0.0.1:${status.port}`, status.accessToken);
    }
  }, []);

  const resolveReachableInternalCollaborationEndpoint = useCallback(async (status: CollaborationServerStatus) => {
    const candidates = [
      status.localUrl,
      `http://localhost:${status.port}`,
    ].filter(Boolean);
    const errors: string[] = [];

    for (const candidate of candidates) {
      const baseUrl = candidate.replace(/\/+$/, '');
      try {
        const response = await fetch(`${baseUrl}/health`, {
          cache: 'no-store',
          redirect: 'error',
          ...(status.accessToken ? { headers: { authorization: `Bearer ${status.accessToken}` } } : {}),
        });
        if (response.ok) {
          return serverStatusToEndpoint(status, baseUrl);
        }
        errors.push(`${baseUrl} 返回 HTTP ${response.status}`);
      } catch (error) {
        errors.push(`${baseUrl} ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`本机协作服务器已启动，但应用无法访问健康检查：${errors.join('；')}`);
  }, [serverStatusToEndpoint]);

  const stopStartedCollaborationServerAfterHostFailure = useCallback(async () => {
    const current = await window.aeonStageryAPI.collaborationServer.getStatus().catch(() => null);
    if (!current?.success) {
      showToast('无法确认协作房间状态，本机服务器保持运行。', 'warning');
      return;
    }
    if (current.status?.hasState) {
      setCollaborationServerStatus(current.status);
      showToast('协作房间仍保留在本机服务器，可重新连接。', 'warning');
      return;
    }
    const result = await window.aeonStageryAPI.collaborationServer.stop().catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (result.success) {
      setCollaborationServerStatus(null);
      showToast('未能进入协作，刚启动的本机协作服务器已停止。', 'warning');
      return;
    }
    showToast(`未能进入协作，且本机协作服务器停止失败：${result.error || '未知错误'}`, 'error');
  }, []);

  const handleHostNewCollaboration = useCallback(async ({
    name,
    rootPath,
    displayName,
    port,
    allowNetwork,
    password,
  }: {
    name: string;
    rootPath: string;
    displayName: string;
    port: number;
    allowNetwork?: boolean;
    password?: string;
  }) => {
    setIsCollaborationJoinHomeLocked(true);
    const workflowResult = await contextValue.services.projectOpenWorkflow.createProjectAndLoadDefaultScene({ name, rootPath });
    showProjectWorkflowResult(workflowResult, 'create', false);
    if (!workflowResult.success || !workflowResult.project) {
      setIsCollaborationJoinHomeLocked(false);
      return;
    }

    let stopServerOnFailure = false;
    let roomCreated = false;
    try {
      const { status: serverStatus, reused } = await startInternalCollaborationServer({
        projectId: workflowResult.project.metadata.projectId,
        port,
        allowNetwork,
        password,
      });
      stopServerOnFailure = !reused && !serverStatus.hasState;
      const endpoint = await resolveReachableInternalCollaborationEndpoint(serverStatus);
      const ok = await collaborationController.hostCurrentScene({
        endpoint,
        displayName,
        password: password || serverStatus.connectionPassword,
        project: workflowResult.project,
        isServerHost: true,
      });
      if (ok) {
        roomCreated = true;
        setCollaborationServerStatus({ ...serverStatus, hasState: true });
      } else {
        if (stopServerOnFailure) {
          stopServerOnFailure = false;
          await stopStartedCollaborationServerAfterHostFailure();
        }
      }
    } catch (error: unknown) {
      if (stopServerOnFailure && !roomCreated) {
        await stopStartedCollaborationServerAfterHostFailure();
      }
      showToast(`主持协作失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      releaseCollaborationJoinHomeLockAfterRoomCreated(
        roomCreated,
        setIsCollaborationJoinHomeLocked,
      );
    }
  }, [
    collaborationController,
    contextValue.services.projectOpenWorkflow,
    resolveReachableInternalCollaborationEndpoint,
    showProjectWorkflowResult,
    startInternalCollaborationServer,
    stopStartedCollaborationServerAfterHostFailure,
  ]);

  const handleHostExistingCollaboration = useCallback(async ({
    displayName,
    port,
    allowNetwork,
    password,
  }: {
    displayName: string;
    port: number;
    allowNetwork?: boolean;
    password?: string;
  }) => {
    setIsCollaborationJoinHomeLocked(true);
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择要主持的 AeonStagery 项目',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'AeonStagery Project', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      setIsCollaborationJoinHomeLocked(false);
      return;
    }

    const workflowResult = await contextValue.services.projectOpenWorkflow.openProjectAndLoadDefaultScene(result.filePaths[0]);
    showProjectWorkflowResult(workflowResult, 'open', false);
    if (!workflowResult.success || !workflowResult.project) {
      setIsCollaborationJoinHomeLocked(false);
      return;
    }

    let stopServerOnFailure = false;
    let roomCreated = false;
    try {
      const { status: serverStatus, reused } = await startInternalCollaborationServer({
        projectId: workflowResult.project.metadata.projectId,
        port,
        allowNetwork,
        password,
      });
      stopServerOnFailure = !reused && !serverStatus.hasState;
      const endpoint = await resolveReachableInternalCollaborationEndpoint(serverStatus);
      const ok = await collaborationController.hostCurrentScene({
        endpoint,
        displayName,
        password: password || serverStatus.connectionPassword,
        project: workflowResult.project,
        isServerHost: true,
      });
      if (ok) {
        roomCreated = true;
        setCollaborationServerStatus({ ...serverStatus, hasState: true });
      } else {
        if (stopServerOnFailure) {
          stopServerOnFailure = false;
          await stopStartedCollaborationServerAfterHostFailure();
        }
      }
    } catch (error: unknown) {
      if (stopServerOnFailure && !roomCreated) {
        await stopStartedCollaborationServerAfterHostFailure();
      }
      showToast(`主持协作失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      releaseCollaborationJoinHomeLockAfterRoomCreated(
        roomCreated,
        setIsCollaborationJoinHomeLocked,
      );
    }
  }, [
    collaborationController,
    contextValue.services.projectOpenWorkflow,
    resolveReachableInternalCollaborationEndpoint,
    showProjectWorkflowResult,
    startInternalCollaborationServer,
    stopStartedCollaborationServerAfterHostFailure,
  ]);

  const handleJoinCollaboration = useCallback(async ({
    endpoint,
    displayName,
    rootPath,
    password,
  }: {
    endpoint: string;
    displayName: string;
    rootPath: string;
    password?: string;
  }) => {
    setIsCollaborationJoinHomeLocked(true);
    let roomCreated = false;
    try {
      const workflowResult = await contextValue.services.projectOpenWorkflow.prepareCollaborationJoinProject({
        rootPath,
        name: `协作会话 ${new Date().toISOString().slice(0, 10)}`,
      });
      if (!workflowResult.success || !workflowResult.project) {
        showToast(`准备协作目录失败: ${workflowResult.error || '未知错误'}`, 'error');
        return;
      }

      if (!workflowResult.scenePath) {
        showToast('协作目录未能准备好本地场景文件，请重新选择目录后重试', 'error');
        return;
      }

      const loadResult = await contextValue.services.sceneFile.loadFromPath(workflowResult.scenePath);
      if (!loadResult.success) {
        showToast(`加载协作目录中的本地场景失败：${'error' in loadResult ? loadResult.error : '未知错误'}`, 'error');
        return;
      }

      let currentServerStatus = collaborationServerStatus;
      if (!currentServerStatus && window.aeonStageryAPI?.collaborationServer?.getStatus) {
        try {
          const res = await window.aeonStageryAPI.collaborationServer.getStatus();
          if (res?.success && res.status) {
            currentServerStatus = res.status;
            setCollaborationServerStatus(res.status);
          }
        } catch {
          // ignore error fetching server status
        }
      }
      const isServerHost = isMatchingCollaborationServerHost(endpoint, currentServerStatus);

      const ok = await collaborationController.joinExistingRoom({
        endpoint,
        password,
        displayName,
        project: workflowResult.project,
        isServerHost,
      });
      if (!ok) return;
      roomCreated = true;
    } finally {
      releaseCollaborationJoinHomeLockAfterRoomCreated(
        roomCreated,
        setIsCollaborationJoinHomeLocked,
      );
    }
  }, [collaborationController, collaborationServerStatus, contextValue.services.projectOpenWorkflow, contextValue.services.sceneFile]);

  const handleStopCollaborationServer = useCallback(async () => {
    const result = await window.aeonStageryAPI.collaborationServer.stop();
    if (!result.success) {
      showToast(`停止协作服务器失败: ${result.error}`, 'error');
      return;
    }
    setCollaborationServerStatus(null);
    showToast('已停止本机协作服务器', 'info');
  }, []);

  const effectiveServerCredentials: CollaborationServerCredentials | null = useMemo(() => {
    if (collaborationServerStatus?.running) {
      const lanOrLocal = collaborationServerStatus.lanUrls[0] || collaborationServerStatus.localUrl;
      const fallbackInvite = collaborationServerStatus.accessToken
        ? [withCollaborationAccessToken(lanOrLocal, collaborationServerStatus.accessToken)]
        : undefined;
      const inviteUrls = (collaborationServerStatus.inviteUrls && collaborationServerStatus.inviteUrls.length > 0)
        ? collaborationServerStatus.inviteUrls
        : (collaborationController.sessionCredentials?.inviteUrls?.length
          ? collaborationController.sessionCredentials.inviteUrls
          : fallbackInvite);

      return {
        ...collaborationServerStatus,
        connectionPassword: collaborationServerStatus.connectionPassword
          || collaborationController.sessionCredentials?.connectionPassword,
        accessToken: collaborationServerStatus.accessToken
          || collaborationController.sessionCredentials?.accessToken,
        inviteUrls,
        serverAddress: lanOrLocal,
      };
    }
    if (collaborationController.sessionCredentials) {
      return {
        connectionPassword: collaborationController.sessionCredentials.connectionPassword,
        accessToken: collaborationController.sessionCredentials.accessToken,
        inviteUrls: collaborationController.sessionCredentials.inviteUrls,
        localUrl: collaborationController.sessionCredentials.serverAddress,
        serverAddress: collaborationController.sessionCredentials.serverAddress,
      };
    }
    return collaborationServerStatus;
  }, [collaborationController.sessionCredentials, collaborationServerStatus]);

  const shouldShowCollaborationPanel =
    collaborationStatus !== 'disconnected'
    || collaborationController.isBusy
    || Boolean(collaborationServerStatus?.running);

  return {
    collaborationController, collaborationServerStatus, effectiveServerCredentials,
    shouldShowCollaborationPanel, handleHostNewCollaboration, handleHostExistingCollaboration,
    handleJoinCollaboration, handleStopCollaborationServer,
  };
}
