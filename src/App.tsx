import { isMatchingCollaborationServerHost, withCollaborationAccessToken } from './services/collaboration/CollaborationTransport';
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { isSettingsDialogTab } from './ui/settingsNavigation';
import { eventBus } from './api/events';
import {
  IconAgent,
  IconAiProse,
  IconCrosshair,
  IconFilm,
  IconFolder,
  IconInfo,
  IconMaximize,
  IconMoon,
  IconRefresh,
  IconSave,
  IconSettings,
  IconSparkles,
  IconSun,
  IconTarget,
  IconVolume2,
  IconZoomIn,
  IconZoomOut,
} from './ui/icons';
import {
  useGizmosVisible,
  useEditorState,
  useSelectedActionCount,
  useSemanticDocument,
  useValidationIssues,
} from './ui/store/storeHooks';
import { registerSceneSummaryProvider } from './services/crash/CrashReporter';
import { buildRedactedSceneSummary } from './services/crash/sceneSummary';
import {
  createExternalLibraryMount,
  hasExternalLibraryMountPath,
  removeRecentProject,
  rebindExternalLibraryMount,
  useSettings,
} from './ui/SettingsStore';
import { getLogger } from './engine/Logger';
import { useResizableLayout } from './ui/hooks/useResizableLayout';
import { useViewport } from './ui/hooks/useViewport';
import { useKeyboardShortcuts } from './ui/hooks/useKeyboardShortcuts';
import { StatusBar } from './ui/StatusBar';
import { ToastContainer, showToast } from './ui/Toast';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { useSceneMigrationDialog } from './ui/hooks/useSceneMigrationDialog';
import { SceneMigrationConfirmationDialog } from './ui/SceneMigrationConfirmationDialog';
import { AppProvider, isCollaborationUndoDisabled, useTimelineAdapter } from './ui/context/AppContext';
import type { InspectorPanelView } from './ui/timeline/InspectorViewPicker';
import { bootstrap, type BootstrapContext } from './engine/Bootstrapper';
import { scriptEngine } from './engine/ScriptEngine';
import { cameraController } from './engine/CameraController';
import { resolveVec2 } from './engine/utils/math';
import { ProjectHome } from './ui/onboarding/ProjectHome';
import { FirstLessonController } from './ui/onboarding/FirstLessonController';
import { TemplateProjectConfigDialog } from './ui/templates/TemplateProjectConfigDialog';
import { TemplatePerformanceProfileEditor } from './ui/templates/TemplatePerformanceProfileEditor';
import { WebGalRegenerateDialog } from './ui/WebGalRegenerateDialog';
import { Live2DRuntimeMissingDialog } from './ui/live2d/Live2DRuntimeMissingDialog';
import { detectLive2DRuntimeStatus } from './services/live2d/live2dRuntimeDetection';
import type { Live2DRuntimeStatusReport } from './api/types/live2dRuntime';
import type { WebGalImportInput } from './services/import/webgal';
import type { ProjectState, ProjectTemplateConfiguration } from './api/types/project';
import { AUTHORING_SCHEMA_VERSION } from './api/types/authoring';
import type { TemplatePackageSummary } from './services/template-package';
import type {
  CollaborationConnectionStatus,
  CollaborationIdentity,
  CollaborationPresencePatchV2,
  CollaborationPresencePeerV2,
} from './api/types/collaboration';
import type { CustomMotionEditLeaseGate } from './services/timeline-authoring/CustomMotionEditLeaseGate';
import { CollaborationConnectPanel, type CollaborationServerCredentials } from './ui/CollaborationConnectPanel';
import { useSemanticCollaborationSession } from './ui/useSemanticCollaborationSession';
import {
  areWorkspaceToolsSceneIdentitiesEqual,
  type WorkspaceRuntimeSnapshot,
  type WorkspaceToolTab,
  type WorkspaceToolsCommand,
  type WorkspaceToolsCommandResult,
  type WorkspaceToolsSnapshot,
} from './ui/workspace-tools/types';
import type { SceneMeta } from './api/types/scene-common';
import type { SettingsDialogTab } from './ui/SettingsDialog';
import { formatShortcutBinding, getEffectiveShortcutBindings } from './ui/shortcuts/shortcutUtils';

type CollaborationServerStatus = {
  running: boolean;
  host: string;
  port: number;
  dataDir: string;
  localUrl: string;
  lanUrls: string[];
  accessToken?: string;
  connectionPassword?: string;
  inviteUrls?: string[];
  assetRoot: string;
  hasState: boolean;
};

type SidePanelView = 'inspector' | 'workspace-tools';

export function releaseCollaborationJoinHomeLockAfterRoomCreated(
  roomCreated: boolean,
  setLocked: (locked: boolean) => void,
): void {
  if (roomCreated) {
    setLocked(false);
  }
}

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

const appLogger = getLogger('App');

const LazyTimelineEditor = React.lazy(() => import('./ui/TimelineEditor'));
const LazyExportDialog = React.lazy(() => import('./ui/ExportDialog'));
const StageOverlay = React.lazy(() => import('./ui/StageOverlay'));
const LazyAgentGenerator = React.lazy(() => import('./ui/AgentGeneratorPanel'));
const PlaybackControls = React.lazy(() => import('./ui/PlaybackControls'));
const BakeProgressOverlay = React.lazy(() => import('./ui/BakeProgressOverlay'));
const SettingsDialog = React.lazy(() => import('./ui/SettingsDialog').then(m => ({ default: m.SettingsDialog })));
const VoiceWorkbench = React.lazy(() => import('./ui/voice/VoiceWorkbench').then(m => ({ default: m.VoiceWorkbench })));

export default function App() {
  const contextValue = useMemo(() => bootstrap(), []);
  const [collaborationStatus, setCollaborationStatus] = useState<CollaborationConnectionStatus>('disconnected');
  const [collaborationSelf, setCollaborationSelf] = useState<CollaborationIdentity | null>(null);
  const [collaborationPeers, setCollaborationPeers] = useState<CollaborationPresencePeerV2[]>([]);
  const [customMotionEditLeaseGate, setCustomMotionEditLeaseGate] = useState<CustomMotionEditLeaseGate | null>(null);
  const collaborationPresencePublisherRef = useRef<(patch?: Partial<CollaborationPresencePatchV2>) => void>(() => {});
  const publishCollaborationPresence = useCallback((patch?: Partial<CollaborationPresencePatchV2>) => {
    collaborationPresencePublisherRef.current(patch);
  }, []);
  const setCollaborationPresencePublisher = useCallback((
    publisher: ((patch?: Partial<CollaborationPresencePatchV2>) => void) | null,
  ) => {
    collaborationPresencePublisherRef.current = publisher ?? (() => {});
  }, []);

  return (
    <AppProvider
      adapters={contextValue.adapters}
      stores={contextValue.stores}
      services={contextValue.services}
      collaboration={{
        status: collaborationStatus,
        self: collaborationSelf,
        peers: collaborationPeers,
        publishPresence: publishCollaborationPresence,
        customMotionEditLeaseGate,
      }}
    >
      <AppContent
        contextValue={contextValue}
        collaborationStatus={collaborationStatus}
        collaborationPeers={collaborationPeers}
        setCollaborationStatus={setCollaborationStatus}
        setCollaborationSelf={setCollaborationSelf}
        setCollaborationPeers={setCollaborationPeers}
        setCollaborationPresencePublisher={setCollaborationPresencePublisher}
        setCustomMotionEditLeaseGate={setCustomMotionEditLeaseGate}
      />
    </AppProvider>
  );
}

function AppContent({
  contextValue,
  collaborationStatus,
  collaborationPeers,
  setCollaborationStatus,
  setCollaborationSelf,
  setCollaborationPeers,
  setCollaborationPresencePublisher,
  setCustomMotionEditLeaseGate,
}: {
  contextValue: BootstrapContext;
  collaborationStatus: CollaborationConnectionStatus;
  collaborationPeers: CollaborationPresencePeerV2[];
  setCollaborationStatus: (status: CollaborationConnectionStatus) => void;
  setCollaborationSelf: (self: CollaborationIdentity | null) => void;
  setCollaborationPeers: (peers: CollaborationPresencePeerV2[]) => void;
  setCollaborationPresencePublisher: (publisher: ((patch?: Partial<CollaborationPresencePatchV2>) => void) | null) => void;
  setCustomMotionEditLeaseGate: (gate: CustomMotionEditLeaseGate | null) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const stageAreaRef = useRef<HTMLDivElement>(null);
  const inspectorDetailVisibleRef = useRef(false);
  const canvasMountRef = useRef<HTMLDivElement>(null);
  const { settings, setSetting } = useSettings();
  const [initialized, setInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [showWebGalRegenerate, setShowWebGalRegenerate] = useState(false);
  const [showAIWorkbench, setShowAIWorkbench] = useState(false);
  const [showVoiceWorkbench, setShowVoiceWorkbench] = useState(false);
  const [voiceWorkbenchContext, setVoiceWorkbenchContext] = useState<import('./ui/voice/VoiceWorkbench').VoiceWorkbenchContext>({ mode: 'free' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSettingsClosing, setIsSettingsClosing] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsDialogTab>('general');
  const settingsCloseTimerRef = useRef<number | null>(null);
  const [isWorkspaceToolsOpen, setIsWorkspaceToolsOpen] = useState(false);
  const [isInspectorDetailVisible, setIsInspectorDetailVisible] = useState(false);
  const [sidePanelView, setSidePanelView] = useState<SidePanelView>(() => (
    settings.workbenchContextPanelOpen ? 'workspace-tools' : 'inspector'
  ));
  const [windowWidth, setWindowWidth] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth : 1920
  ));
  const [contextTab, setContextTab] = useState<WorkspaceToolTab>(() => settings.workbenchContextTab);
  const [currentProject, setCurrentProject] = useState<ProjectState | null>(() => contextValue.services.projectWorkspace.getCurrentProject());
  const [templatePackages, setTemplatePackages] = useState<TemplatePackageSummary[]>(
    () => contextValue.services.templatePackages.getSummaries(),
  );
  const [templatePackageRevision, setTemplatePackageRevision] = useState(
    () => contextValue.services.templatePackages.getRevision(),
  );
  const [isPerformanceProfileEditorDirty, setIsPerformanceProfileEditorDirty] = useState(false);
  const [defaultProjectName, setDefaultProjectName] = useState('AeonStagery Project');
  const [defaultProjectLocation, setDefaultProjectLocation] = useState('');
  const [collaborationServerStatus, setCollaborationServerStatus] = useState<CollaborationServerStatus | null>(null);
  const [isCollaborationJoinHomeLocked, setIsCollaborationJoinHomeLocked] = useState(false);

  const [showLive2DRuntimeDialog, setShowLive2DRuntimeDialog] = useState(false);
  const [live2DRuntimeReport, setLive2DRuntimeReport] = useState<Live2DRuntimeStatusReport | null>(null);

  useEffect(() => {
    let mounted = true;
    void detectLive2DRuntimeStatus().then((report) => {
      if (!mounted) return;
      setLive2DRuntimeReport(report);
      if (report.missingAny) {
        setShowLive2DRuntimeDialog(true);
      }
    }).catch((err) => {
      console.warn('[Live2D] Failed to detect runtime status on startup:', err);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    return eventBus.on('ui:openLive2DRuntimeDialog', () => {
      setShowLive2DRuntimeDialog(true);
    });
  }, []);

  useEffect(() => {
    const serverApi = window.aeonStageryAPI?.collaborationServer;
    if (!serverApi?.getStatus) return;
    let mounted = true;
    void serverApi.getStatus().then((result) => {
      if (mounted && result.success) setCollaborationServerStatus(result.status ?? null);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const { document: semanticDocument } = useSemanticDocument();
  const hasLoadedScene = !!semanticDocument;
  const { gizmosVisible, setGizmosVisible } = useGizmosVisible();
  const selectedActionCount = useSelectedActionCount();
  const timelineAdapter = useTimelineAdapter();
  const {
    filePath,
    handleSave,
    saveStatus,
    selectedActionIds,
  } = useEditorState();

  // Register a redacted scene-summary provider so crash reports carry useful
  // structural context (statement count + timeline outline) without script text.
  useEffect(() => {
    return registerSceneSummaryProvider(() => buildRedactedSceneSummary(semanticDocument));
  }, [semanticDocument, filePath]);
  const workspaceToolsBridge = window.aeonStageryAPI?.workspaceTools;
  const collaborationController = useSemanticCollaborationSession({
    contextValue,
    currentProject,
    status: collaborationStatus,
    peers: collaborationPeers,
    onStatusChange: setCollaborationStatus,
    onSelfChange: setCollaborationSelf,
    onPeersChange: setCollaborationPeers,
    onPresencePublisherChange: setCollaborationPresencePublisher,
    onLeaseGateChange: setCustomMotionEditLeaseGate,
    collaborationServerStatus,
  });
  const sceneMigrationDialog = useSceneMigrationDialog(contextValue.services.sceneMigration);

  const layoutOptions = useMemo(() => ({
    initialPanelWidth: settings.workbenchPanelWidth,
    initialDetailWidth: settings.workbenchDetailWidth,
    initialTimelineHeight: settings.workbenchTimelineHeight,
    onPanelWidthCommit: (width: number) => setSetting('workbenchPanelWidth', width),
    onDetailWidthCommit: (width: number) => setSetting('workbenchDetailWidth', width),
    onTimelineHeightCommit: (height: number) => setSetting('workbenchTimelineHeight', height),
  }), [
    settings.workbenchDetailWidth,
    settings.workbenchPanelWidth,
    settings.workbenchTimelineHeight,
    setSetting,
  ]);
  const {
    panelWidth,
    detailWidth,
    timelineHeight,
    handleMouseDown,
    handleDetailMouseDown,
    handleDetailKeyDown,
    handleHeightMouseDown,
  } = useResizableLayout(layoutOptions);
  const { issues: globalIssues, errorsCount, warningsCount } = useValidationIssues();

  useEffect(() => {
    const updateWorkspaceSize = () => {
      setWindowWidth(window.innerWidth);
    };
    updateWorkspaceSize();
    window.addEventListener('resize', updateWorkspaceSize);
    return () => window.removeEventListener('resize', updateWorkspaceSize);
  }, []);

  useEffect(() => {
    const conversationBridge = window.aeonStageryAPI?.conversation;
    if (!conversationBridge?.onDebugLog) return undefined;
    return conversationBridge.onDebugLog((entry) => {
      console.info(`[LLM debug] ${entry.tag}`, entry.payload);
    });
  }, []);

  useEffect(() => eventBus.on('ui:openVoiceWorkbench', (payload: unknown) => {
    const requested = payload && typeof payload === 'object' ? payload as Partial<import('./ui/voice/VoiceWorkbench').VoiceWorkbenchContext> : {};
    setVoiceWorkbenchContext(requested.mode === 'dialogue' ? {
      mode: 'dialogue',
      statementId: requested.statementId,
      sceneId: requested.sceneId,
      characterId: requested.characterId,
      characterName: requested.characterName,
      voiceProfileId: requested.voiceProfileId,
      text: requested.text ?? '',
    } : { mode: 'free', text: requested.text ?? '' });
    setShowVoiceWorkbench(true);
  }), []);

  const handleSetContextTab = useCallback((tab: WorkspaceToolTab) => {
    setContextTab(tab);
    setSetting('workbenchContextTab', tab);
  }, [setSetting]);

  const handleSetSidePanelView = useCallback((view: SidePanelView) => {
    setSidePanelView(view);
    setSetting('workbenchContextPanelOpen', view === 'workspace-tools');
  }, [setSetting]);

  const handleSelectWorkspaceView = useCallback((tab: WorkspaceToolTab) => {
    handleSetContextTab(tab);
    handleSetSidePanelView('workspace-tools');
  }, [handleSetContextTab, handleSetSidePanelView]);

  const handleSelectInspectorView = useCallback((view: InspectorPanelView) => {
    if (view === 'actions') {
      handleSetSidePanelView('inspector');
      return;
    }
    handleSelectWorkspaceView(view);
  }, [handleSelectWorkspaceView, handleSetSidePanelView]);

  const workspaceToolsPanelWidth = Math.max(panelWidth, 400);
  const inspectorNavigatorWidth = sidePanelView === 'workspace-tools'
    ? workspaceToolsPanelWidth
    : panelWidth;
  const inspectorLayout = windowWidth - inspectorNavigatorWidth - detailWidth >= 720
    ? 'split'
    : 'replace';
  const sidePanelWidth = inspectorNavigatorWidth + (
    inspectorLayout === 'split' && isInspectorDetailVisible
      ? detailWidth + 4
      : 0
  );
  const navigatorReplacedByDetail = sidePanelView === 'inspector'
    && inspectorLayout === 'replace'
    && isInspectorDetailVisible
    && selectedActionCount > 0;
  const navigatorPriorityActive = settings.workbenchTimelineLayoutMode === 'list'
    && hasLoadedScene
    && !navigatorReplacedByDetail;
  const timelinePanelWidth = navigatorPriorityActive
    ? 'auto'
    : '100%';
  const timelinePanelMarginRight = navigatorPriorityActive
    ? inspectorNavigatorWidth
    : 0;

  const handleInspectorDetailVisibilityChange = useCallback((visible: boolean) => {
    if (inspectorDetailVisibleRef.current === visible) return;
    inspectorDetailVisibleRef.current = visible;
    setIsInspectorDetailVisible(visible);
  }, []);

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
  useEffect(() => {
    const unsubscribeProject = contextValue.services.projectWorkspace.subscribe(() => {
      const project = contextValue.services.projectWorkspace.getCurrentProject();
      setCurrentProject(project);
    });
    const unsubscribeTemplates = contextValue.services.templatePackages.subscribe(() => {
      setTemplatePackages(contextValue.services.templatePackages.getSummaries());
      setTemplatePackageRevision(contextValue.services.templatePackages.getRevision());
    });
    return () => {
      unsubscribeProject();
      unsubscribeTemplates();
    };
  }, [contextValue.services.projectWorkspace, contextValue.services.templatePackages]);

  useEffect(() => {
    let mounted = true;

    const initialize = async () => {
      try {
        contextValue.stores.playback.setEngineStatus('initializing');
        const defaultProjectsPath = await window.aeonStageryAPI.app.getDefaultProjectsPath();
        if (!mounted) return;
        setDefaultProjectLocation(defaultProjectsPath.replace(/\\/g, '/'));
        setDefaultProjectName(`AeonStagery Project ${new Date().toISOString().slice(0, 10)}`);

        if (canvasMountRef.current) {
          await contextValue.adapters.stage.mount(canvasMountRef.current);
        }

        if (!mounted) return;
        setInitialized(true);
        contextValue.stores.playback.setEngineStatus('ready');
      } catch (err: any) {
        appLogger.error('Failed to initialize application', err);
        if (!mounted) return;
        setInitError(err?.message || String(err));
        contextValue.stores.playback.setEngineStatus('error');
      }
    };

    void initialize();
    return () => {
      mounted = false;
    };
  }, [contextValue]);

  useEffect(() => {
    const unsubscribeOpenSettings = eventBus.on('ui:openSettings', (payload: unknown) => {
      if (settingsCloseTimerRef.current !== null) {
        window.clearTimeout(settingsCloseTimerRef.current);
        settingsCloseTimerRef.current = null;
      }
      const requestedTab = typeof payload === 'object' && payload && 'tab' in payload
        ? (payload as { tab?: unknown }).tab
        : null;
      setSettingsInitialTab(
        isSettingsDialogTab(requestedTab) ? requestedTab : 'general',
      );
      setIsSettingsClosing(false);
      setIsSettingsOpen(true);
    });

    return () => {
      if (settingsCloseTimerRef.current !== null) {
        window.clearTimeout(settingsCloseTimerRef.current);
      }
      unsubscribeOpenSettings();
    };
  }, []);

  const handleCloseSettings = useCallback(() => {
    if (!isSettingsOpen || isSettingsClosing) return;
    if (isPerformanceProfileEditorDirty && !window.confirm('AI 表演模板有未保存修改。仍要关闭设置并丢弃这些修改吗？')) return;
    setIsSettingsClosing(true);
    settingsCloseTimerRef.current = window.setTimeout(() => {
      setIsSettingsOpen(false);
      setIsSettingsClosing(false);
      settingsCloseTimerRef.current = null;
    }, 220);
  }, [isPerformanceProfileEditorDirty, isSettingsClosing, isSettingsOpen]);

  const validationBanner = useMemo(() => {
    if (globalIssues.length === 0) {
      return null;
    }

    const severity = errorsCount > 0 ? 'error' : 'warning';
    const summaryParts: string[] = [];
    if (errorsCount > 0) summaryParts.push(`${errorsCount} 个错误`);
    if (warningsCount > 0) summaryParts.push(`${warningsCount} 个警告`);

    const leadMessage = globalIssues[0]?.message ? `：${globalIssues[0].message}` : '';
    return {
      key: `${errorsCount}:${warningsCount}:${globalIssues.map((issue) => `${issue.actionId ?? 'global'}:${issue.message}`).join('|')}`,
      severity,
      message: `场景校验发现 ${summaryParts.join('，')}${leadMessage}`,
    };
  }, [errorsCount, globalIssues, warningsCount]);

  const handleOpenDiagnostics = useCallback(() => {
    handleSelectWorkspaceView('diagnostics');
  }, [handleSelectWorkspaceView]);

  const handleRestartApp = useCallback(async () => {
    const confirmed = window.confirm('确认重新启动应用？未保存的更改可能会丢失。');
    if (!confirmed) {
      return;
    }
    await window.aeonStageryAPI.app.restart();
  }, []);

  const handleLoadFile = useCallback(async (): Promise<boolean> => {
    const res = await contextValue.services.sceneFile.loadFile();
    if (res.success) {
      showToast('剧本加载成功！', 'success');
      if (res.issues && res.issues.length > 0) {
        const errors = res.issues.filter((i: any) => i.severity === 'error');
        const warnings = res.issues.filter((i: any) => i.severity === 'warning');
        const parts: string[] = [];
        if (errors.length) parts.push(`${errors.length} 个错误`);
        if (warnings.length) parts.push(`${warnings.length} 个警告`);
        showToast(`场景校验: ${parts.join('，')} · 查看控制台了解详情`, 'warning');
      }
      return true;
    }
    if ('error' in res) {
      showToast(`加载剧本失败: ${res.error}`, 'error');
    }
    return false;
  }, [contextValue.services.sceneFile]);

  const showProjectWorkflowResult = useCallback((result: any, mode: 'create' | 'open' | 'recent', notifySuccess = true) => {
    if (!result.success) {
      if (result.outcome === 'project_create_failed') {
        showToast(`创建项目失败: ${result.error}`, 'error');
        return;
      }
      if (result.outcome === 'project_open_failed') {
        showToast(`${mode === 'recent' ? '打开最近项目失败' : '打开项目失败'}: ${result.error}`, 'error');
        return;
      }
      if (result.outcome === 'default_scene_load_failed') {
        showToast(`打开项目失败（默认场景校验未通过）: ${result.error}`, 'error');
        return;
      }
      return;
    }

    const verb = mode === 'create' ? '已创建项目并加载默认场景' : '已打开项目并加载默认场景';
    if (notifySuccess) showToast(`${verb}: ${result.project.metadata.name}`, 'success');
    if (result.issues && result.issues.length > 0) {
      const errors = result.issues.filter((i: any) => i.severity === 'error');
      const warnings = result.issues.filter((i: any) => i.severity === 'warning');
      const parts: string[] = [];
      if (errors.length) parts.push(`${errors.length} 个错误`);
      if (warnings.length) parts.push(`${warnings.length} 个警告`);
      showToast(`场景校验: ${parts.join('，')} · 查看控制台了解详情`, 'warning');
    }
  }, []);

  const handleCreateProject = useCallback(async ({
    name,
    rootPath,
    templates,
    webgal,
  }: {
    name: string;
    rootPath: string;
    templates?: ProjectTemplateConfiguration;
    webgal?: WebGalImportInput;
  }) => {
    setIsCollaborationJoinHomeLocked(false);
    const result = await contextValue.services.projectOpenWorkflow.createProjectAndLoadDefaultScene({
      name,
      rootPath,
      templates,
      webgal,
    });
    if (result.success && result.webgalReport) {
      const { stats, characters, unsupportedCommands } = result.webgalReport;
      const parts = [
        `对白 ${stats.dialogueCount + stats.narrationCount} 句`,
        `角色 ${characters.length} 个`,
        `背景 ${stats.backgroundChanges} 处`,
      ];
      if (unsupportedCommands.length > 0) parts.push(`未识别指令 ${unsupportedCommands.length} 条`);
      const scriptCount = 1 + (webgal?.additionalScripts?.length ?? 0);
      showToast(
        `已导入 WebGAL 剧本${scriptCount > 1 ? `（${scriptCount} 个剧本合并连续演出）` : ''}：${parts.join('、')}`,
        'success',
      );
    }
    showProjectWorkflowResult(result, 'create');
  }, [contextValue.services.projectOpenWorkflow, showProjectWorkflowResult]);

  const handleRegenerateWebGalScene = useCallback(async (speed: number) => {
    setShowWebGalRegenerate(false);
    const result = await contextValue.services.projectOpenWorkflow.regenerateWebGalSceneAndReload({ speed });
    if (result.success) {
      showToast('已重新生成 WebGAL 场景', 'success');
      if (result.webgalReport && result.webgalReport.unsupportedCommands.length > 0) {
        showToast(`重新生成中 ${result.webgalReport.unsupportedCommands.length} 条指令未识别（已跳过）`, 'warning');
      }
    } else {
      showToast(`重新生成失败：${result.error ?? '未知错误'}`, 'error');
    }
  }, [contextValue.services.projectOpenWorkflow]);

  const handleRegisterWebGalAssetSource = useCallback(async () => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择 WebGAL 素材目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;

    const nextPath = result.filePaths[0].replace(/\\/g, '/').replace(/[\\/]+$/, '');
    const existing = settings.externalLibraryMounts || [];
    const existingMount = existing.find((mount) => (
      mount.path.replace(/\\/g, '/').replace(/[\\/]+$/, '').toLowerCase() === nextPath.toLowerCase()
    ));
    if (existingMount) {
      return { mountId: existingMount.id, path: existingMount.path };
    }

    const mount = createExternalLibraryMount(nextPath, existing);
    setSetting('externalLibraryMounts', [...existing, mount]);
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已连接 WebGAL 素材目录', 'success');
    return { mountId: mount.id, path: mount.path };
  }, [settings.externalLibraryMounts, setSetting]);

  const handleSaveTemplateConfiguration = useCallback(async (
    templates: ProjectTemplateConfiguration,
    options: { importCharacters?: boolean } = {},
  ) => {
    const previousDialoguePresentation = contextValue.services.projectWorkspace
      .getCurrentProject()?.metadata.templates?.dialoguePresentation;
    await contextValue.services.templatePackages.refresh();
    const result = await contextValue.services.projectWorkspace.updateTemplateConfiguration(templates);
    if (!result.success) {
      showToast(result.error, 'error');
      return;
    }

    const nextTemplates = result.project.metadata.templates;
    const nextDialoguePresentation = nextTemplates?.dialoguePresentation;
    if (hasLoadedScene && previousDialoguePresentation) {
      const document = contextValue.services.semanticAuthoring.getDocumentSnapshot();
      const previousStyleId = previousDialoguePresentation.styleId;
      const refreshTargets = document.statements.filter((statement) => {
        if (statement.type !== 'dialogue') return false;
        const presentation = statement.params.presentation as typeof previousDialoguePresentation | undefined;
        if (!presentation || presentation.renderer !== 'image-dialogue-v1') return false;
        return previousStyleId
          ? presentation.styleId === previousStyleId
          : JSON.stringify(presentation) === JSON.stringify(previousDialoguePresentation);
      });
      if (refreshTargets.length > 0) {
        await contextValue.services.semanticAuthoring.authorTransaction(refreshTargets.map((statement) => {
          const params = { ...statement.params } as Record<string, unknown>;
          if (nextDialoguePresentation) {
            delete params.template;
            params.presentation = JSON.parse(JSON.stringify(nextDialoguePresentation));
          } else {
            delete params.presentation;
            params.template = nextTemplates?.dialogueTemplate ?? 'glass';
          }
          return {
            version: AUTHORING_SCHEMA_VERSION,
            correlationId: `template_style_refresh_${statement.id}`,
            origin: 'template-config' as const,
            kind: 'update-statement' as const,
            statementId: statement.id,
            patch: { params },
          };
        }));
      }
    }

    if (options.importCharacters) {
      if (!hasLoadedScene) {
        showToast('当前没有加载场景，已仅保存模板配置', 'warning');
        return;
      }
      try {
        const characters = await contextValue.services.projectWorkspace.prepareTemplateCharacters(templates);
        const receipt = await contextValue.services.semanticAuthoring.applyCharacterCommand({
          kind: 'add-template-characters',
          origin: 'template-config',
          characters,
        });
        if (receipt.affectedCharacterIds.length > 0) {
          showToast(`已导入 ${receipt.affectedCharacterIds.length} 个模板角色`, 'success');
        } else {
          showToast('模板配置已保存；选中的角色已在当前场景中', 'info');
        }
      } catch (error: any) {
        showToast(`模板角色导入失败: ${error?.message || String(error)}`, 'error');
        return;
      }
    } else {
      showToast('模板配置已保存', 'success');
    }
  }, [
    contextValue.services.semanticAuthoring,
    contextValue.services.templatePackages,
    contextValue.services.projectWorkspace,
    hasLoadedScene,
  ]);

  const handleBrowseCreateLocation = useCallback(async (_currentPath: string) => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择项目位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return null;
    }
    return result.filePaths[0].replace(/\\/g, '/');
  }, []);

  const handleBrowseCollaborationDirectory = useCallback(async (_currentPath: string) => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择协作本地目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return null;
    }
    return result.filePaths[0].replace(/\\/g, '/');
  }, []);

  const handleOpenProject = useCallback(async () => {
    setIsCollaborationJoinHomeLocked(false);
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '打开 AeonStagery 项目',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'AeonStagery Project', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return;

    const workflowResult = await contextValue.services.projectOpenWorkflow.openProjectAndLoadDefaultScene(result.filePaths[0]);
    showProjectWorkflowResult(workflowResult, 'open');
  }, [contextValue.services.projectOpenWorkflow, showProjectWorkflowResult]);

  useEffect(() => {
    return eventBus.on('ui:openProject', handleOpenProject);
  }, [handleOpenProject]);

  const handleOpenRecentProject = useCallback(async (projectFilePath: string) => {
    setIsCollaborationJoinHomeLocked(false);
    const workflowResult = await contextValue.services.projectOpenWorkflow.openRecentProjectAndLoadDefaultScene(projectFilePath);
    showProjectWorkflowResult(workflowResult, 'recent');
  }, [contextValue.services.projectOpenWorkflow, showProjectWorkflowResult]);

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
    } catch (error: any) {
      if (stopServerOnFailure && !roomCreated) {
        await stopStartedCollaborationServerAfterHostFailure();
      }
      showToast(`主持协作失败: ${error?.message || String(error)}`, 'error');
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
    } catch (error: any) {
      if (stopServerOnFailure && !roomCreated) {
        await stopStartedCollaborationServerAfterHostFailure();
      }
      showToast(`主持协作失败: ${error?.message || String(error)}`, 'error');
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

  const handleImportTemplatePackage = useCallback(async () => {
    const templateImporter = window.aeonStageryAPI.templates;
    if (!templateImporter) {
      showToast('当前桌面版本不支持导入模板包，请更新应用', 'error');
      return;
    }
    const result = await templateImporter.importZip();
    if (!result.success) {
      if (!result.canceled) showToast(`模板包导入失败：${result.error ?? '未知错误'}`, 'error');
      return;
    }
    await contextValue.services.templatePackages.refresh();
    showToast(
      `${result.package.replaced ? '已更新' : '已导入'}模板：${result.package.name} ${result.package.version}`,
      'success',
    );
  }, [contextValue.services.templatePackages]);

  const handleChooseExternalLibrary = useCallback(async () => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择外部素材库目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return;
    }

    const nextPath = result.filePaths[0];
    const existing = settings.externalLibraryMounts || [];
    const deduped = hasExternalLibraryMountPath(existing, nextPath)
      ? existing
      : [...existing, createExternalLibraryMount(nextPath, existing)];
    setSetting('externalLibraryMounts', deduped);
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已连接外部素材库', 'success');
  }, [settings.externalLibraryMounts, setSetting]);

  const handleReplaceExternalLibrary = useCallback(async (index: number) => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '替换外部素材库目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return;
    }

    const nextPath = result.filePaths[0];
    const existing = settings.externalLibraryMounts || [];
    const nextMounts = rebindExternalLibraryMount(existing, index, nextPath);
    setSetting('externalLibraryMounts', nextMounts);
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已更新外部素材库', 'success');
  }, [settings.externalLibraryMounts, setSetting]);

  const handleRemoveExternalLibrary = useCallback((index: number) => {
    const existing = settings.externalLibraryMounts || [];
    const nextMounts = existing.filter((_, mountIndex) => mountIndex !== index);
    setSetting('externalLibraryMounts', nextMounts);
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已移除外部素材库', 'info');
  }, [settings.externalLibraryMounts, setSetting]);

  const handleSkipExternalLibrary = useCallback(async () => {
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已跳过外部素材库设置，可稍后在设置中补充', 'info');
  }, [setSetting]);

  const shouldPromptExternalLibrary = !settings.hasCompletedExternalLibraryOnboarding
    && (settings.externalLibraryMounts?.length ?? 0) === 0;
  const externalLibraryPaths = (settings.externalLibraryMounts || []).map((mount) => mount.path);
  const showProjectHome = initialized && !initError && (!currentProject || isCollaborationJoinHomeLocked);
  const {
    viewport,
    handleStageMouseDown,
    handleStageReset,
    handleResetZoom,
    handleRecenter,
    handleZoomIn,
    handleZoomOut,
    isPanning,
  } = useViewport(stageRef, !showProjectHome);
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
  const saveShortcutTitle = useMemo(() => {
    const [binding] = getEffectiveShortcutBindings(settings.keyboardShortcuts, 'app.save');
    const suffix = binding ? ` (${formatShortcutBinding(binding)})` : '';
    return `保存场景${suffix}`;
  }, [settings.keyboardShortcuts]);

  const handlePlayPause = useCallback(() => {
    const playback = contextValue.adapters.playback;
    if (contextValue.stores.playback.playing) {
      playback.pause();
    } else {
      playback.play();
    }
  }, [contextValue]);

  const handleFrameStep = useCallback((dir: 1 | -1) => {
    const playback = contextValue.adapters.playback;
    const t = playback.getCurrentTime();
    playback.seek(Math.max(0, t + dir * (1 / 60)));
  }, [contextValue]);

  const handleUndo = useCallback(() => {
    if (isCollaborationUndoDisabled(collaborationStatus)) {
      showToast('协作模式暂不支持撤销', 'info');
      return;
    }
    void contextValue.services.semanticAuthoring.undo();
  }, [collaborationStatus, contextValue]);

  const handleRedo = useCallback(() => {
    if (isCollaborationUndoDisabled(collaborationStatus)) {
      showToast('协作模式暂不支持重做', 'info');
      return;
    }
    void contextValue.services.semanticAuthoring.redo();
  }, [collaborationStatus, contextValue]);

  useKeyboardShortcuts({
    initialized,
    onPlayPause: handlePlayPause,
    onStageReset: handleStageReset,
    onFrameStep: handleFrameStep,
    onSave: () => { if (hasLoadedScene) void handleSave(); },
    onOpenProject: () => { void handleOpenProject(); },
    onExport: () => { if (!showProjectHome) setShowExport(true); },
    onOpenShortcutSettings: () => { void eventBus.emit('ui:openSettings', { tab: 'shortcuts' }); },
    onUndo: handleUndo,
    onRedo: handleRedo,
  });

  return (
    <div
      className="app-container"
      data-timeline-layout={navigatorPriorityActive ? 'list' : 'tracks'}
      style={{
        '--workbench-timeline-extension': `${timelineHeight + 4}px`,
        '--workbench-navigator-width': `${inspectorNavigatorWidth}px`,
      } as React.CSSProperties}
    >
      <div className="top-bar">
        <div className="top-bar__title">
          <img src="./icon.png" alt="AeonStagery" className="top-bar__logo" width={22} height={22} />
          <span className="top-bar__brand">AeonStagery</span>
          {currentProject && (
            <span className="top-bar__project-name" title={currentProject.rootPath}>
              {currentProject.metadata.name}
            </span>
          )}
          <button
            className="btn btn--icon top-bar__project-action"
            onClick={() => void handleSave()}
            disabled={!hasLoadedScene}
            title={saveShortcutTitle}
            aria-label="保存场景"
          >
            <IconSave width={15} height={15} />
          </button>
          <button
            className="btn btn--icon top-bar__project-action"
            onClick={() => void handleOpenProject()}
            title="打开项目 (Ctrl+O)"
            aria-label="打开项目"
          >
            <IconFolder width={15} height={15} />
          </button>
        </div>
        <div className="top-bar__actions">
          <div className="top-bar__group top-bar__group--status" aria-label="状态">
            {hasLoadedScene && validationBanner && (
              <button
                className={`validation-pill validation-pill--${validationBanner.severity}`}
                onClick={handleOpenDiagnostics}
                title={`${validationBanner.message}。点击打开问题诊断面板。`}
              >
                <IconInfo width={14} height={14} />
                {errorsCount > 0 && <span>{errorsCount} 错误</span>}
                {warningsCount > 0 && <span>{warningsCount} 警告</span>}
              </button>
            )}
            {shouldShowCollaborationPanel && (
              <CollaborationConnectPanel
                currentProject={currentProject}
                sceneDocument={semanticDocument}
                status={collaborationStatus}
                peers={collaborationPeers}
                controller={collaborationController}
                serverCredentials={effectiveServerCredentials}
                disabled={!initialized || showProjectHome}
              />
            )}
          </div>
          <div className="top-bar__group top-bar__group--output" aria-label="生成与导出">
            {currentProject?.metadata.webGalImport && (
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => setShowWebGalRegenerate(true)}
                disabled={!initialized || showProjectHome}
                title="用保存的 WebGAL 剧本重新生成场景（可换阅读速度）"
              >
                <IconRefresh width={14} height={14} /> 重新生成
              </button>
            )}

            {/* AI 与语音创作工具组合 */}
            <div className="top-bar__creation-capsule">
              <button
                className={`btn btn--secondary btn--sm top-bar__ai-trigger ${showAIWorkbench ? 'btn--active' : ''}`}
                onClick={() => setShowAIWorkbench(!showAIWorkbench)}
                title={showProjectHome ? '打开项目后可使用 AI 铺戏' : '打开或关闭 AI 铺戏工作台（智能编排对话与演出）'}
                aria-pressed={showAIWorkbench}
                disabled={!initialized || showProjectHome}
              >
                <IconAiProse width={14} height={14} /> AI 铺戏
              </button>
              <button
                className="btn btn--secondary btn--sm top-bar__ai-trigger"
                onClick={() => void window.aeonStageryAPI?.projectAgent?.openWindow()}
                title="打开项目 Agent 独立对话窗口（全知全能的场景创作助手）"
                disabled={!initialized}
              >
                <IconAgent width={14} height={14} /> 项目 Agent
              </button>
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => void eventBus.emit('ui:openVoiceWorkbench', { mode: 'free' })}
                title="语音配音工作台（角色配音生成与试听）"
                disabled={!initialized}
              >
                <IconVolume2 width={14} height={14} /> 语音
              </button>
            </div>

            <button
              className="btn btn--primary btn--sm top-bar__export-btn"
              onClick={() => setShowExport(true)}
              disabled={!initialized || showProjectHome}
              title={showProjectHome ? '打开项目后可导出' : '导出场景渲染成高清视频'}
            >
              <IconFilm width={14} height={14} /> 导出
            </button>
          </div>
          <details className="top-bar__more">
            <summary className="btn btn--icon" title="更多操作" aria-label="更多操作">
              <span aria-hidden="true">•••</span>
            </summary>
            <div className="top-bar__menu" role="menu">
              <button
                className="top-bar__menu-item"
                onClick={() => {
                  const nextTheme = settings.theme === 'dark' ? 'light' : 'dark';
                  setSetting('theme', nextTheme);
                }}
                role="menuitem"
                title="切换浅色或深色主题"
              >
                {settings.theme === 'light' ? <IconMoon width={15} height={15} /> : <IconSun width={15} height={15} />}
                切换主题
              </button>
              <button className="top-bar__menu-item" onClick={() => void eventBus.emit('ui:openSettings')} role="menuitem">
                <IconSettings width={15} height={15} />
                全局设置
              </button>
              <button className="top-bar__menu-item" onClick={() => setShowLive2DRuntimeDialog(true)} role="menuitem" title="配置 Live2D 运行时与查看状态">
                <IconSparkles width={15} height={15} />
                Live2D 运行时
              </button>
              <button className="top-bar__menu-item" onClick={() => void handleRestartApp()} disabled={showProjectHome} role="menuitem">
                <IconRefresh width={15} height={15} />
                重新启动
              </button>
            </div>
          </details>
        </div>
      </div>

      <div className="main-content" data-navigator-extended={navigatorPriorityActive}>
        <ErrorBoundary name="舞台">
          <div className="stage-area" ref={stageAreaRef}>
            <div
              className="stage-container"
              ref={stageRef}
              onMouseDown={(e) => {
                if (showProjectHome) return;
                handleStageMouseDown(e);
                if (selectedActionCount > 0 && e.button === 0 && e.target === e.currentTarget) {
                  timelineAdapter.select({});
                }
              }}
              style={{ cursor: showProjectHome ? 'default' : (isPanning.current ? 'grabbing' : 'grab') }}
            >
              <div
                ref={canvasMountRef}
                style={{
                  width: '100%',
                  height: '100%',
                  transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                  transformOrigin: 'center center',
                  transition: isPanning.current ? 'none' : 'transform 0.1s ease-out',
                  pointerEvents: 'none',
                  visibility: showProjectHome ? 'hidden' : 'visible'
                }}
              >
                {initialized && <React.Suspense fallback={null}><StageOverlay /></React.Suspense>}
              </div>

              {/* 舞台悬浮视口工具栏 HUD */}
              {!showProjectHome && hasLoadedScene && initialized && (
                <div className="stage-viewport-hud" role="toolbar" aria-label="舞台视口控制">
                  <button
                    type="button"
                    className="stage-viewport-hud__btn stage-viewport-hud__btn--zoom-pill"
                    onClick={handleResetZoom}
                    title="点击重置缩放至 100%（渲染器始终完整显示舞台，100% 即适配窗口基准）"
                  >
                    {Math.round(viewport.zoom * 100)}%
                  </button>
                  <button
                    type="button"
                    className="stage-viewport-hud__btn"
                    onClick={handleZoomOut}
                    title="缩小画面 (滚轮向下)"
                    aria-label="缩小画面"
                  >
                    <IconZoomOut width={13} height={13} />
                  </button>
                  <button
                    type="button"
                    className="stage-viewport-hud__btn"
                    onClick={handleZoomIn}
                    title="放大画面 (滚轮向上)"
                    aria-label="放大画面"
                  >
                    <IconZoomIn width={13} height={13} />
                  </button>
                  <button
                    type="button"
                    className="stage-viewport-hud__btn"
                    onClick={handleStageReset}
                    title="适配舞台窗口并回中 (Fit)"
                    aria-label="适配舞台窗口大小"
                  >
                    <IconMaximize width={13} height={13} />
                  </button>
                  <button
                    type="button"
                    className="stage-viewport-hud__btn"
                    onClick={handleRecenter}
                    title="视角回中（仅重置画面平移，保留当前缩放）"
                    aria-label="视角回中"
                  >
                    <IconCrosshair width={13} height={13} />
                  </button>
                  <div className="stage-viewport-hud__divider" />
                  <button
                    type="button"
                    className={`stage-viewport-hud__btn ${gizmosVisible ? 'is-active' : ''}`}
                    onClick={() => setGizmosVisible(!gizmosVisible)}
                    title={gizmosVisible ? "关闭构图辅助线" : "打开构图辅助线"}
                    aria-label="构图辅助线"
                  >
                    <IconTarget width={13} height={13} />
                  </button>
                </div>
              )}

              {currentProject && !hasLoadedScene && initialized && !initError && (
                <div className="empty-state" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)', zIndex: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                  <h2 style={{ color: 'white', fontSize: 20, marginBottom: 8, fontWeight: 600 }}>未加载场景内容</h2>
                  <p style={{ color: 'rgba(255,255,255,0.7)', marginBottom: 20, maxWidth: 420, textAlign: 'center', fontSize: 13, lineHeight: 1.5 }}>
                    当前项目没有处于活动状态的场景。你可以载入场景文件，或返回项目主页。
                  </p>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <button className="btn" onClick={handleLoadFile} style={stageLoadButtonStyle}>
                      打开场景文件 (.json)
                    </button>
                    <button
                      className="btn"
                      onClick={() => contextValue.services.projectWorkspace.closeProject()}
                      style={{ ...stageLoadButtonStyle, background: 'rgba(255,255,255,0.1)', color: '#e2e8f0' }}
                    >
                      返回项目主页
                    </button>
                  </div>
                </div>
              )}

              {initialized && <React.Suspense fallback={null}><BakeProgressOverlay /></React.Suspense>}
            </div>
            <React.Suspense fallback={null}><PlaybackControls /></React.Suspense>
          </div>
        </ErrorBoundary>

        {showAIWorkbench && (
          <div className="ai-prose-workbench-overlay" onMouseDown={() => setShowAIWorkbench(false)}>
            <div
              className="ai-prose-workbench-window"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ai-prose-workbench-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <React.Suspense fallback={<div className="empty-state">AI 铺戏加载中...</div>}>
                <LazyAgentGenerator onClose={() => setShowAIWorkbench(false)} />
              </React.Suspense>
            </div>
          </div>
        )}

        <div className="resize-handle" onMouseDown={handleMouseDown} />

        <div
          className="side-panel"
          data-navigator-extended={navigatorPriorityActive}
          data-detail-visible={isInspectorDetailVisible}
          style={{ width: sidePanelWidth }}
        >
          <ErrorBoundary name="属性面板">
            <div className="side-panel__content">
              <React.Suspense fallback={<div className="empty-state" style={panelEmptyStateStyle}>加载中...</div>}>
                {hasLoadedScene ? (
                  <LazyTimelineEditor
                    mode="inspector"
                    inspectorLayout={inspectorLayout}
                    inspectorNavigatorWidth={inspectorNavigatorWidth}
                    inspectorDetailWidth={detailWidth}
                    inspectorView={sidePanelView === 'workspace-tools' ? contextTab : 'actions'}
                    onInspectorDetailResizeStart={handleDetailMouseDown}
                    onInspectorDetailResizeKeyDown={handleDetailKeyDown}
                    onInspectorDetailVisibilityChange={handleInspectorDetailVisibilityChange}
                    onSelectInspectorView={handleSelectInspectorView}
                    onDetachWorkspaceTools={() => void handleOpenWorkspaceTools()}
                    canDetachWorkspaceTools={!!workspaceToolsBridge}
                  />
                ) : <div className="empty-state" style={panelEmptyStateStyle}>等待场景加载...</div>}
              </React.Suspense>
            </div>
          </ErrorBoundary>
        </div>

      </div>

      <div
        className="resize-handle-horiz"
        style={{ width: timelinePanelWidth, marginRight: timelinePanelMarginRight }}
        onMouseDown={handleHeightMouseDown}
      />

      {navigatorPriorityActive && (
        <div
          className="navigator-resize-extension"
          style={{
            right: inspectorNavigatorWidth,
            bottom: 28,
            height: timelineHeight + 4,
          }}
          onMouseDown={handleMouseDown}
          role="separator"
          aria-label="调整剧本动作面板宽度"
          aria-orientation="vertical"
        />
      )}

      <ErrorBoundary name="时间轴">
        <div
          className="bottom-panel"
          style={{
            width: timelinePanelWidth,
            height: timelineHeight,
            marginRight: timelinePanelMarginRight,
          }}
        >
          {hasLoadedScene ? (
              <React.Suspense fallback={<div className="empty-state" style={panelEmptyStateStyle}>轨道加载中...</div>}>
                <LazyTimelineEditor
                  mode="tracks"
                />
              </React.Suspense>
            ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontWeight: 700 }}>
              轨道编辑器（当前未加载场景）
            </div>
          )}
        </div>
      </ErrorBoundary>

      <StatusBar />

      {showExport && (
        <React.Suspense fallback={null}><LazyExportDialog onClose={() => setShowExport(false)} /></React.Suspense>
      )}

      {currentProject?.metadata.webGalImport && (
        <WebGalRegenerateDialog
          open={showWebGalRegenerate}
          scriptName={currentProject.metadata.webGalImport.scriptName}
          defaultSpeed={currentProject.metadata.webGalImport.speed}
          onCancel={() => setShowWebGalRegenerate(false)}
          onConfirm={handleRegenerateWebGalScene}
        />
      )}

      {sceneMigrationDialog.request && (
        <SceneMigrationConfirmationDialog
          request={sceneMigrationDialog.request}
          onConfirm={sceneMigrationDialog.confirm}
          onCancel={sceneMigrationDialog.cancel}
        />
      )}

      {showLive2DRuntimeDialog && (
        <Live2DRuntimeMissingDialog
          isOpen={showLive2DRuntimeDialog}
          onClose={() => setShowLive2DRuntimeDialog(false)}
          report={live2DRuntimeReport}
        />
      )}

      <React.Suspense fallback={null}>
        {(isSettingsOpen || isSettingsClosing) && (
          <SettingsDialog
            isOpen={isSettingsOpen}
            isClosing={isSettingsClosing}
            initialTab={settingsInitialTab}
            onClose={handleCloseSettings}
            templateContent={(
              <div className="settings-template-panel">
                <div className="settings-template-panel__actions">
                  <button className="btn" onClick={() => void handleImportTemplatePackage()}>导入模板包</button>
                </div>
                {currentProject ? (
                  <TemplateProjectConfigDialog
                    key={currentProject.metadata.projectId}
                    embedded
                    isOpen={isSettingsOpen}
                    templatePackages={templatePackages}
                    value={currentProject.metadata.templates}
                    onClose={handleCloseSettings}
                    onSave={handleSaveTemplateConfiguration}
                  />
                ) : (
                  <p className="settings-template-panel__empty">未打开项目。AI 表演模板可独立编辑；项目模板启用顺序与角色导入会在打开项目后显示。</p>
                )}
                <TemplatePerformanceProfileEditor
                  service={contextValue.services.templatePerformanceProfiles}
                  packages={contextValue.services.templatePackages.getPackages()}
                  revision={templatePackageRevision}
                  enabledTemplateIds={currentProject
                    ? currentProject.metadata.templates?.enabledTemplateIds ?? []
                    : undefined}
                  onDirtyChange={setIsPerformanceProfileEditorDirty}
                />
              </div>
            )}
          />
        )}
      </React.Suspense>

      <React.Suspense fallback={null}>
        <VoiceWorkbench
          isOpen={showVoiceWorkbench}
          context={voiceWorkbenchContext}
          project={currentProject}
          config={settings.gptSovits}
          service={contextValue.services.voiceAuthoring}
          onClose={() => setShowVoiceWorkbench(false)}
        />
      </React.Suspense>

      <FirstLessonController
        semanticDocument={semanticDocument}
        externalLibraryPaths={externalLibraryPaths}
        defaultProjectDirectory={defaultProjectLocation}
        fileAccess={contextValue.services.fileAccess}
        projectOpenWorkflow={contextValue.services.projectOpenWorkflow}
        projectResources={contextValue.services.projectResources}
        characterAdapter={contextValue.adapters.character}
        playbackStore={contextValue.stores.playback}
      >
        {({ startFirstLesson }) => showProjectHome ? (
          <ProjectHome
            defaultProjectName={defaultProjectName}
            defaultProjectLocation={defaultProjectLocation}
            collaborationEndpoint={collaborationController.endpoint}
            collaborationDisplayName={collaborationController.displayName}
            collaborationStatus={collaborationStatus}
            assetHandshake={collaborationController.assetHandshake}
            onCancelResourceTransfer={collaborationController.cancelResourceTransfer}
            collaborationServerStatus={collaborationServerStatus}
            shouldPromptExternalLibrary={shouldPromptExternalLibrary}
            externalLibraryPaths={externalLibraryPaths}
            templatePackages={templatePackages}
            recentProjects={settings.recentProjects || []}
            onCreateProject={handleCreateProject}
            onBrowseCreateLocation={handleBrowseCreateLocation}
            onRegisterWebGalAssetSource={handleRegisterWebGalAssetSource}
            onBrowseCollaborationDirectory={handleBrowseCollaborationDirectory}
            onOpenProject={handleOpenProject}
            onImportTemplatePackage={handleImportTemplatePackage}
            onOpenRecentProject={handleOpenRecentProject}
            onRemoveRecentProject={removeRecentProject}
            onHostNewCollaboration={handleHostNewCollaboration}
            onHostExistingCollaboration={handleHostExistingCollaboration}
            onJoinCollaboration={handleJoinCollaboration}
            onStopCollaborationServer={handleStopCollaborationServer}
            onStartTutorial={startFirstLesson}
            onChooseExternalLibrary={handleChooseExternalLibrary}
            onReplaceExternalLibrary={handleReplaceExternalLibrary}
            onRemoveExternalLibrary={handleRemoveExternalLibrary}
            onSkipExternalLibrary={handleSkipExternalLibrary}
          />
        ) : null}
      </FirstLessonController>

      <ToastContainer />
    </div>
  );
}

const panelEmptyStateStyle: React.CSSProperties = {
  color: 'var(--text-primary)',
  fontWeight: 700,
  opacity: 1,
};

const stageLoadButtonStyle: React.CSSProperties = {
  minHeight: 48,
  padding: '14px 28px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid rgba(255,255,255,0.22)',
  background: '#111827',
  color: '#ffffff',
  fontSize: 15,
  fontWeight: 800,
  boxShadow: '0 10px 28px rgba(0,0,0,0.34)',
};
