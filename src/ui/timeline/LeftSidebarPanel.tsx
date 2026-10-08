import React, { useState, useMemo, useCallback, useSyncExternalStore } from 'react';
import {
  usePlaybackAdapter,
  useDocumentStore,
  useSemanticAuthoringService,
  useTimelineAdapter,
  useTemplatePackageCatalog,
  useCollaborationStatus,
} from '../context/AppContext';
import { useEditorState, useSemanticDocument, useValidationIssues } from '../store/storeHooks';
import { TimelineListView } from './TimelineListView';
import { CharacterDirectoryPanel } from './CharacterDirectoryPanel';
import { IconFilm, IconUsers } from '../icons';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';
import { AUTHORING_SCHEMA_VERSION } from '../../api/types/authoring';
import {
  createSemanticTimelineCorrelationId,
  defaultDialogueStatementDraft,
  selectCompiledActionsForStatements,
} from './semanticTimelineEditing';
import type { TimelineScene } from './semanticTimelineTypes';
import type { WorkspaceToolTab } from '../workspace-tools/types';

const stableEmptyPackages: never[] = [];
const getStableEmptyPackages = () => stableEmptyPackages;

export interface LeftSidebarPanelProps {
  width?: number;
  className?: string;
  activeTab?: 'timeline' | 'characters';
  onTabChange?: (tab: 'timeline' | 'characters') => void;
  defaultTab?: 'timeline' | 'characters';
}

export const LeftSidebarPanel: React.FC<LeftSidebarPanelProps> = ({
  width,
  className,
  activeTab: controlledTab,
  onTabChange,
  defaultTab = 'timeline',
}) => {
  const [internalTab, setInternalTab] = useState<'timeline' | 'characters'>(defaultTab);
  const currentTab = controlledTab ?? internalTab;

  const handleTabChange = useCallback((tab: 'timeline' | 'characters') => {
    if (controlledTab === undefined) {
      setInternalTab(tab);
    }
    onTabChange?.(tab);
  }, [controlledTab, onTabChange]);

  const handleTabKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      handleTabChange(currentTab === 'timeline' ? 'characters' : 'timeline');
    }
  }, [currentTab, handleTabChange]);

  const { document: semanticDocument } = useSemanticDocument();
  const documentStore = useDocumentStore();
  const playbackAdapter = usePlaybackAdapter();
  const semanticAuthoring = useSemanticAuthoringService();
  const timelineAdapter = useTimelineAdapter();
  const collaborationStatus = useCollaborationStatus();
  const { selectedActionIds, setSelectedIds, loadExample } = useEditorState();
  const { issues: validationIssues } = useValidationIssues();

  const templateCatalog = useTemplatePackageCatalog();
  const templatePackageSnapshot = useSyncExternalStore(
    templateCatalog ? (listener) => templateCatalog.subscribe(listener) : () => () => {},
    templateCatalog ? () => templateCatalog.getPackages() : getStableEmptyPackages,
    getStableEmptyPackages,
  );
  const availableTemplates = useMemo(
    () => {
      void templatePackageSnapshot;
      return templateCatalog?.getSemanticAuthoringCombos() ?? [];
    },
    [templateCatalog, templatePackageSnapshot],
  );

  const semanticTimelineItems = useMemo(
    () => buildSemanticTimelineReadModel(
      semanticDocument,
      documentStore.getCompiledSceneSnapshot(),
    ),
    [documentStore, semanticDocument],
  );

  const timelineReadModelActions = useMemo(
    () => semanticTimelineItems.map((item) => item.displayAction),
    [semanticTimelineItems],
  );

  const sceneData = useMemo<TimelineScene | null>(() => {
    if (!semanticDocument) return null;
    return {
      sceneId: semanticDocument.sceneId,
      meta: semanticDocument.meta,
      visual: semanticDocument.visual,
      timeline: timelineReadModelActions,
    };
  }, [semanticDocument, timelineReadModelActions]);

  const handleSelect = useCallback((idOrIds: string | string[], isMulti?: boolean) => {
    if (Array.isArray(idOrIds)) {
      const next: Record<string, boolean> = {};
      idOrIds.forEach((id) => { next[id] = true; });
      setSelectedIds(next);
      timelineAdapter.select(next);
    } else if (isMulti) {
      const current = { ...selectedActionIds };
      if (current[idOrIds]) {
        delete current[idOrIds];
      } else {
        current[idOrIds] = true;
      }
      setSelectedIds(current);
      timelineAdapter.select(current);
    } else {
      const next = { [idOrIds]: true };
      setSelectedIds(next);
      timelineAdapter.select(next);
    }
  }, [selectedActionIds, setSelectedIds, timelineAdapter]);

  const addAction = useCallback(async () => {
    if (collaborationStatus === 'offline' || collaborationStatus === 'reconnecting') return;
    if (!semanticDocument || !semanticAuthoring) return;
    const time = playbackAdapter.getCurrentTime();
    const roundedTime = Math.max(0, Math.round(time * 10) / 10);
    const receipt = await semanticAuthoring.author({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: createSemanticTimelineCorrelationId('timeline_add'),
      origin: 'timeline-editor',
      kind: 'insert-statement',
      anchorTime: roundedTime,
      statement: defaultDialogueStatementDraft(semanticDocument),
    });
    const nextSelected = selectCompiledActionsForStatements(
      documentStore.getCompiledSceneSnapshot(),
      receipt.createdStatementIds,
    );
    if (Object.keys(nextSelected).length > 0) {
      setSelectedIds(nextSelected);
      timelineAdapter.select(nextSelected);
    }
  }, [collaborationStatus, documentStore, playbackAdapter, semanticAuthoring, semanticDocument, setSelectedIds, timelineAdapter]);

  const handleSelectWorkspaceView = useCallback((tab: WorkspaceToolTab) => {
    if (tab === 'characters') {
      handleTabChange('characters');
    }
  }, [handleTabChange]);

  const workspaceErrorCount = useMemo(
    () => validationIssues.filter((i) => i.severity === 'error').length,
    [validationIssues],
  );
  const workspaceWarningCount = useMemo(
    () => validationIssues.filter((i) => i.severity === 'warning').length,
    [validationIssues],
  );

  const timelineCount = semanticTimelineItems.length;
  const characterCount = semanticDocument?.meta?.characters?.length ?? 0;

  return (
    <aside
      className={`left-panel ${className ?? ''}`.trim()}
      data-testid="left-sidebar-panel"
      aria-label="左侧工作区面板"
      style={width ? { width } : undefined}
    >
      <div className="left-panel__tabs" role="tablist" aria-label="左侧工作区选项卡">
        <button
          type="button"
          role="tab"
          id="left-panel-tab-timeline"
          aria-label="剧本时间轴"
          aria-selected={currentTab === 'timeline'}
          aria-controls="left-panel-tabpanel-timeline"
          tabIndex={currentTab === 'timeline' ? 0 : -1}
          className={`left-panel__tab ${currentTab === 'timeline' ? 'left-panel__tab--active' : ''}`}
          onClick={() => handleTabChange('timeline')}
          onKeyDown={handleTabKeyDown}
        >
          <IconFilm className="left-panel__tab-icon" width={13} height={13} aria-hidden="true" />
          <span className="left-panel__tab-text">剧本时间轴</span>
          {timelineCount > 0 && (
            <span className="left-panel__tab-badge" aria-hidden="true">
              {timelineCount}
            </span>
          )}
          {workspaceErrorCount > 0 ? (
            <span
              className="left-panel__tab-alert-dot"
              data-severity="error"
              title={`${workspaceErrorCount} 个错误`}
              aria-hidden="true"
            />
          ) : workspaceWarningCount > 0 ? (
            <span
              className="left-panel__tab-alert-dot"
              data-severity="warning"
              title={`${workspaceWarningCount} 个警告`}
              aria-hidden="true"
            />
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          id="left-panel-tab-characters"
          aria-label="角色管理"
          aria-selected={currentTab === 'characters'}
          aria-controls="left-panel-tabpanel-characters"
          tabIndex={currentTab === 'characters' ? 0 : -1}
          className={`left-panel__tab ${currentTab === 'characters' ? 'left-panel__tab--active' : ''}`}
          onClick={() => handleTabChange('characters')}
          onKeyDown={handleTabKeyDown}
        >
          <IconUsers className="left-panel__tab-icon" width={13} height={13} aria-hidden="true" />
          <span className="left-panel__tab-text">角色管理</span>
          {characterCount > 0 && (
            <span className="left-panel__tab-badge" aria-hidden="true">
              {characterCount}
            </span>
          )}
        </button>
      </div>

      <div className="left-panel__content">
        <div
          role="tabpanel"
          id="left-panel-tabpanel-timeline"
          aria-label="剧本时间轴"
          aria-labelledby="left-panel-tab-timeline"
          className="left-panel__tabpanel"
          hidden={currentTab !== 'timeline'}
        >
          {sceneData ? (
            <TimelineListView
              sceneData={sceneData}
              inlineExpandable={false}
              selectedActionIds={selectedActionIds}
              setSelectedIds={(ids) => {
                setSelectedIds(ids);
                timelineAdapter.select(ids);
              }}
              addAction={addAction}
              handleSelect={handleSelect}
              setCurrentTime={(t) => playbackAdapter.seek(t)}
              loadExample={loadExample}
              workspaceErrorCount={workspaceErrorCount}
              workspaceWarningCount={workspaceWarningCount}
              availableTemplates={availableTemplates}
              onSelectWorkspaceView={handleSelectWorkspaceView}
            />
          ) : (
            <div className="left-panel__empty-state" data-testid="left-panel-empty-state-timeline">
              <div className="left-panel__empty-icon" aria-hidden="true">
                <IconFilm width={22} height={22} />
              </div>
              <div className="left-panel__empty-title">等待场景加载...</div>
              <div className="left-panel__empty-desc">正在准备剧本与时间轴数据</div>
            </div>
          )}
        </div>

        <div
          role="tabpanel"
          id="left-panel-tabpanel-characters"
          aria-label="角色管理"
          aria-labelledby="left-panel-tab-characters"
          className="left-panel__tabpanel"
          hidden={currentTab !== 'characters'}
        >
          {semanticDocument ? (
            <CharacterDirectoryPanel sceneMeta={semanticDocument.meta} />
          ) : (
            <div className="left-panel__empty-state" data-testid="left-panel-empty-state-characters">
              <div className="left-panel__empty-icon" aria-hidden="true">
                <IconUsers width={22} height={22} />
              </div>
              <div className="left-panel__empty-title">等待场景加载...</div>
              <div className="left-panel__empty-desc">正在准备角色目录与数据</div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

export default LeftSidebarPanel;
