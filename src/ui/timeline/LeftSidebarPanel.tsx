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
          aria-selected={currentTab === 'timeline'}
          aria-controls="left-panel-tabpanel-timeline"
          tabIndex={currentTab === 'timeline' ? 0 : -1}
          className={`left-panel__tab ${currentTab === 'timeline' ? 'left-panel__tab--active' : ''}`}
          onClick={() => handleTabChange('timeline')}
          onKeyDown={handleTabKeyDown}
        >
          剧本时间轴
        </button>
        <button
          type="button"
          role="tab"
          id="left-panel-tab-characters"
          aria-selected={currentTab === 'characters'}
          aria-controls="left-panel-tabpanel-characters"
          tabIndex={currentTab === 'characters' ? 0 : -1}
          className={`left-panel__tab ${currentTab === 'characters' ? 'left-panel__tab--active' : ''}`}
          onClick={() => handleTabChange('characters')}
          onKeyDown={handleTabKeyDown}
        >
          角色管理
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
            <div className="empty-state" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
              等待场景加载...
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
            <div className="empty-state" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
              等待场景加载...
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

export default LeftSidebarPanel;
