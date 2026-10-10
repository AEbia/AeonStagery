import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { eventBus } from './api/events';
import { registerSceneSummaryProvider } from './services/crash/CrashReporter';
import { buildRedactedSceneSummary } from './services/crash/sceneSummary';
import {
  IconAgent,
  IconAiProse,
  IconBell,
  IconCrosshair,
  IconFilm,
  IconFolder,
  IconInfo,
  IconMaximize,
  IconMoon,
  IconRefresh,
  IconSave,
  IconSettings,
  IconSun,
  IconTarget,
  IconVolume2,
  IconZoomIn,
  IconZoomOut,
} from './ui/icons';
import {
  useGizmosVisible,
  useSelectedActionCount,
  useSemanticDocument,
  useEditorState,
  useValidationIssues,
} from './ui/store/storeHooks';
import { removeRecentProject, useSettings } from './ui/SettingsStore';
import { useViewport } from './ui/hooks/useViewport';
import { StatusBar } from './ui/StatusBar';
import { ToastContainer } from './ui/Toast';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { useSceneMigrationDialog } from './ui/hooks/useSceneMigrationDialog';
import { SceneMigrationConfirmationDialog } from './ui/SceneMigrationConfirmationDialog';
import { AppProvider, useTimelineAdapter } from './ui/context/AppContext';
import { LeftSidebarPanel } from './ui/timeline/LeftSidebarPanel';
import { bootstrap, type BootstrapContext } from './engine/Bootstrapper';
import { ProjectHome } from './ui/onboarding/ProjectHome';
import { FirstLessonController } from './ui/onboarding/FirstLessonController';
import { TemplateProjectConfigDialog } from './ui/templates/TemplateProjectConfigDialog';
import { TemplatePerformanceProfileEditor } from './ui/templates/TemplatePerformanceProfileEditor';
import { WebGalRegenerateDialog } from './ui/WebGalRegenerateDialog';
import { Live2DRuntimeMissingDialog } from './ui/live2d/Live2DRuntimeMissingDialog';
import { CollaborationConnectPanel } from './ui/CollaborationConnectPanel';
import { useAppCollaborationState } from './ui/hooks/useAppCollaborationState';
import { useAppCollaborationRoom } from './ui/hooks/useAppCollaborationRoom';
import { useAppDialogs } from './ui/hooks/useAppDialogs';
import { useAppInitialization } from './ui/hooks/useAppInitialization';
import { useAppLayout } from './ui/hooks/useAppLayout';
import { useAppProjectWorkspace } from './ui/hooks/useAppProjectWorkspace';
import { useAppShortcuts } from './ui/hooks/useAppShortcuts';
import { useWorkspaceToolsBridge } from './ui/hooks/useWorkspaceToolsBridge';

export { computeSidePanelWidth } from './ui/hooks/useAppLayout';
export { releaseCollaborationJoinHomeLockAfterRoomCreated } from './ui/hooks/useAppCollaborationRoom';

const LazyTimelineEditor = React.lazy(() => import('./ui/TimelineEditor'));
const LazyExportDialog = React.lazy(() => import('./ui/ExportDialog'));
const StageOverlay = React.lazy(() => import('./ui/StageOverlay'));
const LazyAgentGenerator = React.lazy(() => import('./ui/AgentGeneratorPanel'));
const PlaybackControls = React.lazy(() => import('./ui/PlaybackControls'));
const BakeProgressOverlay = React.lazy(() => import('./ui/BakeProgressOverlay'));
const SettingsDialog = React.lazy(() => import('./ui/SettingsDialog').then(m => ({ default: m.SettingsDialog })));
const ChangelogDialog = React.lazy(() => import('./ui/changelog/ChangelogDialog').then(m => ({ default: m.ChangelogDialog })));
const VoiceWorkbench = React.lazy(() => import('./ui/voice/VoiceWorkbench').then(m => ({ default: m.VoiceWorkbench })));

export default function App() {
  const contextValue = useMemo(() => bootstrap(), []);
  const { collaboration, sessionBindings } = useAppCollaborationState();
  return (
    <AppProvider
      adapters={contextValue.adapters}
      stores={contextValue.stores}
      services={contextValue.services}
      collaboration={collaboration}
    >
      <AppContent contextValue={contextValue} sessionBindings={sessionBindings} />
    </AppProvider>
  );
}

function AppContent({ contextValue, sessionBindings }: {
  contextValue: BootstrapContext;
  sessionBindings: ReturnType<typeof useAppCollaborationState>['sessionBindings'];
}) {
  const { settings, setSetting } = useSettings();
  const { document: semanticDocument } = useSemanticDocument();
  const hasLoadedScene = !!semanticDocument;
  const { gizmosVisible, setGizmosVisible } = useGizmosVisible();
  const selectedActionCount = useSelectedActionCount();
  const timelineAdapter = useTimelineAdapter();
  const { filePath, handleSave } = useEditorState();
  useEffect(() => registerSceneSummaryProvider(
    () => buildRedactedSceneSummary(semanticDocument),
  ), [semanticDocument, filePath]);
  const { issues: globalIssues, errorsCount, warningsCount } = useValidationIssues();
  const sceneMigrationDialog = useSceneMigrationDialog(contextValue.services.sceneMigration);
  const { canvasMountRef, initialized, initError, defaultProjectName, defaultProjectLocation } = useAppInitialization(contextValue);
  const {
    showExport, setShowExport, showWebGalRegenerate, setShowWebGalRegenerate,
    showAIWorkbench, setShowAIWorkbench, showVoiceWorkbench, setShowVoiceWorkbench,
    voiceWorkbenchContext, isSettingsOpen, isSettingsClosing, settingsInitialTab,
    hasUnreadChangelog, isChangelogOpen, setIsChangelogOpen,
    showLive2DRuntimeDialog, setShowLive2DRuntimeDialog, live2DRuntimeReport,
    setIsPerformanceProfileEditorDirty, handleCloseSettings, handleRestartApp,
  } = useAppDialogs();
  const project = useAppProjectWorkspace(contextValue, hasLoadedScene);
  const {
    currentProject, templatePackages, templatePackageRevision, isCollaborationJoinHomeLocked,
    handleLoadFile, handleCreateProject, handleOpenProject, handleOpenRecentProject,
    handleRegenerateWebGalScene, handleRegisterWebGalAssetSource, handleSaveTemplateConfiguration,
    handleBrowseCreateLocation, handleBrowseCollaborationDirectory, handleImportTemplatePackage,
    handleChooseExternalLibrary, handleReplaceExternalLibrary, handleRemoveExternalLibrary,
    handleSkipExternalLibrary, shouldPromptExternalLibrary, externalLibraryPaths,
  } = project;
  const {
    collaborationController, collaborationServerStatus, effectiveServerCredentials,
    shouldShowCollaborationPanel, handleHostNewCollaboration, handleHostExistingCollaboration,
    handleJoinCollaboration, handleStopCollaborationServer,
  } = useAppCollaborationRoom(contextValue, sessionBindings, project);
  const { status: collaborationStatus, peers: collaborationPeers } = sessionBindings;
  const layout = useAppLayout(hasLoadedScene);
  const {
    contextTab, sidePanelView, isTracksMode, leftPanelWidth, sidePanelWidth,
    inspectorNavigatorWidth, isInspectorDetailVisible, navigatorPriorityActive,
    timelinePanelWidth, timelinePanelMarginRight, timelineHeight,
    handleLeftResizeMouseDown, handleLeftResizeKeyDown, handleMouseDown, handleHeightMouseDown,
    handleInspectorDetailVisibilityChange, handleSelectInspectorView, handleSelectWorkspaceView,
  } = layout;
  const { handleOpenWorkspaceTools, canDetachWorkspaceTools } = useWorkspaceToolsBridge(
    contextValue, semanticDocument, currentProject, layout,
  );
  const showProjectHome = initialized && !initError && (!currentProject || isCollaborationJoinHomeLocked);
  const stageRef = useRef<HTMLDivElement>(null);
  const stageAreaRef = useRef<HTMLDivElement>(null);
  const {
    viewport, handleStageMouseDown, handleStageReset, handleResetZoom,
    handleRecenter, handleZoomIn, handleZoomOut, isPanning,
  } = useViewport(stageRef, !showProjectHome);
  const { saveShortcutTitle } = useAppShortcuts({
    contextValue, collaborationStatus, initialized, hasLoadedScene, showProjectHome,
    handleStageReset, handleSave, handleOpenProject, setShowExport,
  });
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
              {hasUnreadChangelog && <span className="top-bar__unread-badge" aria-label="有未读更新" />}
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
              <button
                className="top-bar__menu-item"
                onClick={(e) => {
                  const details = (e.currentTarget.closest('details') as HTMLDetailsElement | null);
                  if (details) details.open = false;
                  setIsChangelogOpen(true);
                }}
                role="menuitem"
                title="查看更新日志与公告"
              >
                <IconBell width={15} height={15} />
                更新日志
                {hasUnreadChangelog && <span className="changelog-unread-dot" title="有未读更新" />}
              </button>
              <button
                className="top-bar__menu-item"
                onClick={(e) => {
                  const details = (e.currentTarget.closest('details') as HTMLDetailsElement | null);
                  if (details) details.open = false;
                  void eventBus.emit('ui:openSettings');
                }}
                role="menuitem"
              >
                <IconSettings width={15} height={15} />
                全局设置
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
        {isTracksMode && (
          <>
            <ErrorBoundary name="左侧面板">
              <LeftSidebarPanel width={leftPanelWidth} />
            </ErrorBoundary>
            <div
              className="resize-handle resize-handle--left"
              role="separator"
              aria-label="调整左侧面板宽度"
              aria-orientation="vertical"
              aria-valuemin={320}
              aria-valuemax={420}
              aria-valuenow={leftPanelWidth}
              tabIndex={0}
              onMouseDown={handleLeftResizeMouseDown}
              onKeyDown={handleLeftResizeKeyDown}
            />
          </>
        )}
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
                    inspectorNavigatorWidth={inspectorNavigatorWidth}
                    inspectorView={sidePanelView === 'workspace-tools' ? contextTab : 'actions'}
                    onInspectorDetailVisibilityChange={handleInspectorDetailVisibilityChange}
                    onSelectInspectorView={handleSelectInspectorView}
                    onDetachWorkspaceTools={() => void handleOpenWorkspaceTools()}
                    canDetachWorkspaceTools={canDetachWorkspaceTools}
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
          data-timeline-layout={settings.workbenchTimelineLayoutMode}
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
          onConfirm={(speed) => {
            setShowWebGalRegenerate(false);
            return handleRegenerateWebGalScene(speed);
          }}
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
          onNeverRemind={() => {
            setSetting('showLive2DRuntimeSetupOnStartup', false);
            setShowLive2DRuntimeDialog(false);
          }}
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

      <React.Suspense fallback={null}>
        {isChangelogOpen && (
          <ChangelogDialog
            isOpen={isChangelogOpen}
            onClose={() => setIsChangelogOpen(false)}
          />
        )}
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
