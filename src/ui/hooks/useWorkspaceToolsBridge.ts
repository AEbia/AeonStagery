import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BootstrapContext } from '../../engine/Bootstrapper';
import { cameraController } from '../../engine/CameraController';
import { scriptEngine } from '../../engine/ScriptEngine';
import { resolveVec2 } from '../../engine/utils/math';
import type { SceneMeta } from '../../api/types/scene-common';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { ProjectState } from '../../api/types/project';
import { useEditorState, useValidationIssues } from '../store/storeHooks';
import { useTimelineAdapter } from '../context/AppContext';
import { useSettings } from '../SettingsStore';
import { showToast } from '../Toast';
import {
  areWorkspaceToolsSceneIdentitiesEqual,
  type WorkspaceRuntimeSnapshot,
  type WorkspaceToolsCommand,
  type WorkspaceToolsCommandResult,
  type WorkspaceToolsSnapshot,
  type WorkspaceToolTab,
} from '../workspace-tools/types';

function captureWorkspaceRuntimeSnapshot(
  sceneMeta: SceneMeta,
  characterAdapter: BootstrapContext['adapters']['character'],
  playing: boolean,
): WorkspaceRuntimeSnapshot {
  const cameraState = cameraController.getState();
  const cameraPosition = resolveVec2(cameraState.position);
  const charactersById = new Map(
    (sceneMeta.characters || []).map((character) => [character.id, character]),
  );
  const characters: WorkspaceRuntimeSnapshot['characters'] = [];

  scriptEngine.transformationProxies.forEach((proxy, id) => {
    const character = charactersById.get(id);
    if (!character?.model) return;
    const core = characterAdapter.getCoreModel(id);
    const model = characterAdapter.getModel(id);
    const values = core?.getParameterValues?.() || core?.paramValues || [];
    const parameterSettings = model?.internalModel?.settings?.parameters || [];
    characters.push({
      id,
      name: character.name || id,
      x: (proxy.x / 1920) * 100,
      y: (proxy.y / 1080) * 100,
      z: proxy.z ?? 0,
      scale: proxy.scale,
      opacity: proxy.opacity,
      parameters: Array.from({ length: Math.min(values.length, 20) }, (_, index) => ({
        index,
        name: parameterSettings[index]?.name || `Param_${index}`,
        value: Number(values[index] ?? 0),
      })),
    });
  });

  return {
    playing,
    camera: {
      x: Number(cameraPosition.x.toFixed(2)),
      y: Number(cameraPosition.y.toFixed(2)),
      zoom: Number(cameraState.zoom.toFixed(2)),
      rotation: Number(cameraState.rotation.toFixed(1)),
    },
    characters,
  };
}

/** Owns detached-window synchronization and rejects stale scene drafts. */
export function useWorkspaceToolsBridge(
  contextValue: BootstrapContext,
  semanticDocument: CurrentSceneDocument | null,
  currentProject: ProjectState | null,
  navigation: {
    contextTab: WorkspaceToolTab;
    handleSetContextTab: (tab: WorkspaceToolTab) => void;
    handleSetSidePanelView: (view: 'inspector' | 'workspace-tools') => void;
  },
) {
  const { contextTab, handleSetContextTab, handleSetSidePanelView } = navigation;
  const { settings } = useSettings();
  const { filePath, selectedActionIds, saveStatus, handleSave } = useEditorState();
  const { issues: globalIssues } = useValidationIssues();
  const timelineAdapter = useTimelineAdapter();
  const workspaceToolsBridge = window.aeonStageryAPI?.workspaceTools;
  const [isWorkspaceToolsOpen, setIsWorkspaceToolsOpen] = useState(false);
  const workspaceToolsSnapshot = useMemo<WorkspaceToolsSnapshot>(() => {
    const compiledActions = contextValue.stores.document.getCompiledSceneSnapshot()?.actions ?? [];
    return {
      sceneMeta: semanticDocument?.meta ?? null,
      timelineActionTimesById: Object.fromEntries(compiledActions.map((action) => [action.id, action.time])),
      sceneIdentity: semanticDocument ? {
        sceneId: semanticDocument.sceneId,
        filePath: filePath ?? undefined,
        projectRoot: currentProject?.rootPath,
      } : null,
      rawScript: semanticDocument ? JSON.stringify(semanticDocument, null, 2) : '',
      filePath: filePath ?? undefined,
      projectName: currentProject?.metadata.name,
      projectRoot: currentProject?.rootPath,
      selectedActionIds: Object.keys(selectedActionIds).filter((id) => selectedActionIds[id]),
      issues: globalIssues.map((issue) => ({
        severity: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
        message: issue.message,
        actionId: issue.actionId,
        actionType: issue.actionType,
      })),
      saveStatus,
      theme: settings.theme,
      activeTab: contextTab,
    };
  }, [
    contextTab,
    contextValue.stores.document,
    currentProject?.metadata.name,
    currentProject?.rootPath,
    filePath,
    globalIssues,
    saveStatus,
    semanticDocument,
    selectedActionIds,
    settings.theme,
  ]);

  const publishWorkspaceToolsSnapshot = useCallback(() => {
    workspaceToolsBridge?.publishSnapshot(workspaceToolsSnapshot);
  }, [workspaceToolsBridge, workspaceToolsSnapshot]);

  const handleOpenWorkspaceTools = useCallback(async () => {
    if (!workspaceToolsBridge || !semanticDocument) return;
    await workspaceToolsBridge.open();
    setIsWorkspaceToolsOpen(true);
  }, [semanticDocument, workspaceToolsBridge]);

  useEffect(() => {
    if (!workspaceToolsBridge || !isWorkspaceToolsOpen) return;
    publishWorkspaceToolsSnapshot();
  }, [
    isWorkspaceToolsOpen,
    publishWorkspaceToolsSnapshot,
    workspaceToolsBridge,
  ]);

  useEffect(() => {
    if (!workspaceToolsBridge) return;
    let disposed = false;
    void workspaceToolsBridge.getWindowState().then((state) => {
      if (!disposed) {
        setIsWorkspaceToolsOpen(state.open);
      }
    });
    return () => {
      disposed = true;
    };
  }, [workspaceToolsBridge]);

  useEffect(() => {
    if (!workspaceToolsBridge) return;

    const unsubscribeRequest = workspaceToolsBridge.onSnapshotRequest(publishWorkspaceToolsSnapshot);
    const unsubscribeState = workspaceToolsBridge.onWindowState((state) => {
      setIsWorkspaceToolsOpen(state.open);
    });
    const unsubscribeCommand = workspaceToolsBridge.onCommand((command: WorkspaceToolsCommand) => {
      void (async () => {
        switch (command.type) {
          case 'set-tab':
            handleSetContextTab(command.tab);
            break;
          case 'select-action':
            handleSetSidePanelView('inspector');
            timelineAdapter.select(command.actionId ? { [command.actionId]: true } : {});
            if (typeof command.time === 'number') {
              await contextValue.adapters.playback.seek(command.time, true);
            }
            break;
          case 'apply-raw-script': {
            const currentIdentity = workspaceToolsSnapshot.sceneIdentity;
            let commandResult: WorkspaceToolsCommandResult;
            if (!areWorkspaceToolsSceneIdentitiesEqual(command.sceneIdentity, currentIdentity)) {
              commandResult = {
                type: 'apply-raw-script-result',
                requestId: command.requestId,
                sceneIdentity: command.sceneIdentity,
                success: false,
                error: '主窗口已切换到其他场景，旧草稿未应用。',
              };
            } else {
              try {
                const result = await contextValue.services.sceneFile.loadFromRawJson(
                  command.rawScript,
                  command.sceneIdentity.filePath,
                );
                commandResult = {
                  type: 'apply-raw-script-result',
                  requestId: command.requestId,
                  sceneIdentity: command.sceneIdentity,
                  success: result.success,
                  error: result.success
                    ? undefined
                    : ('error' in result ? result.error : '未知错误'),
                };
              } catch (error) {
                commandResult = {
                  type: 'apply-raw-script-result',
                  requestId: command.requestId,
                  sceneIdentity: command.sceneIdentity,
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }
            workspaceToolsBridge.publishCommandResult(commandResult);
            if (!commandResult.success) {
              showToast(`场景 JSON 应用失败: ${commandResult.error || '未知错误'}`, 'error');
            }
            break;
          }
          case 'character-command':
            await contextValue.services.semanticAuthoring.applyCharacterCommand({
              ...command.command,
              origin: 'workspace-tools-panel',
            });
            break;
          case 'reload-character': {
            const entry = contextValue.adapters.character.getAllCharacters().get(command.charId);
            if (!entry) break;
            const currentTime = contextValue.adapters.playback.getCurrentTime();
            await contextValue.adapters.character.remove(command.charId);
            await contextValue.adapters.character.add(command.charId, entry.modelPath, entry.config);
            await contextValue.adapters.playback.seek(currentTime, true);
            break;
          }
          case 'set-character-parameter':
            contextValue.adapters.character
              .getCoreModel(command.charId)
              ?.setParamFloat(command.parameterIndex, command.value);
            break;
          case 'save':
            await handleSave();
            break;
        }
      })();
    });

    return () => {
      unsubscribeRequest();
      unsubscribeState();
      unsubscribeCommand();
    };
  }, [
    contextValue.adapters.character,
    contextValue.adapters.playback,
    contextValue.services.semanticAuthoring,
    contextValue.services.sceneFile,
    handleSave,
    handleSetContextTab,
    handleSetSidePanelView,
    publishWorkspaceToolsSnapshot,
    timelineAdapter,
    workspaceToolsBridge,
    workspaceToolsSnapshot.sceneIdentity,
  ]);

  useEffect(() => {
    if (
      !workspaceToolsBridge
      || !isWorkspaceToolsOpen
      || !semanticDocument
    ) {
      return;
    }

    const publishRuntime = () => {
      workspaceToolsBridge.publishRuntime(captureWorkspaceRuntimeSnapshot(
        semanticDocument.meta,
        contextValue.adapters.character,
        contextValue.stores.playback.playing,
      ));
    };
    publishRuntime();
    const interval = window.setInterval(publishRuntime, 200);
    return () => window.clearInterval(interval);
  }, [
    contextValue.adapters.character,
    contextValue.stores.playback,
    isWorkspaceToolsOpen,
    semanticDocument,
    workspaceToolsBridge,
  ]);

  return {
    handleOpenWorkspaceTools, canDetachWorkspaceTools: !!workspaceToolsBridge,
  };
}
