import { TimelineListView } from './TimelineListView';
import { ActionInspector } from './ActionInspector';
import { IconArrowLeft, IconTrash, IconCopy, IconX } from '../icons';
import { useMemo, useSyncExternalStore } from 'react';
import {
  useApp,
  useDocumentStore,
  useSemanticAuthoringService,
  useTemplatePackageCatalog,
} from '../context/AppContext';
import { ContextPanel } from './ContextPanel';
import type { SaveResult } from '../../services/io/SceneFileService';
import {
  inspectorViewSupportsActionDetail,
  type InspectorPanelView,
} from './InspectorViewPicker';
import {
  buildSemanticCopyBufferForTimelineActions,
  buildSemanticDeleteTimelineIntents,
} from './semanticTimelineEditing';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';
import { resolveMatchingTimelineAction } from './selectionHygiene';
import type { TimelineScene } from './semanticTimelineTypes';
import { useSemanticDocument } from '../store/storeHooks';
import { useSettings } from '../SettingsStore';
import { PropertyInspectorShell } from './PropertyInspectorShell';

export interface InspectorAreaProps {
  sceneData: TimelineScene;
  selectedActionIds: Record<string, boolean>;
  setSelectedIds: (ids: Record<string, boolean>) => void;
  inspectorTab: 'basic' | 'transform' | 'state';
  setInspectorTab: (t: 'basic' | 'transform' | 'state') => void;
  updateAction: (id: string, updates: any) => void;
  updateParam: (id: string, key: string, val: any) => void;
  replaceSourceParams?: (id: string, params: Record<string, unknown>) => void;
  deleteAction: (id: string) => void;
  deleteActions?: (ids: readonly string[]) => void | Promise<void>;
  copyActions?: (ids: readonly string[]) => void;
  addActionAt: (time: number) => void;
  addAction: () => void;
  handleSave: () => void | Promise<SaveResult | undefined>;
  handleSelect: (idOrIds: string | string[], multi?: boolean) => void;
  setCurrentTime: (t: number) => void;
  loadExample: () => Promise<boolean>;
  detailOpen: boolean;
  detailClosing?: boolean;
  detailSelectedActionIds?: Record<string, boolean>;
  onDetailOpen: () => void;
  onDetailClose: () => void;
  layoutMode: 'split' | 'replace';
  navigatorWidth: number;
  detailWidth: number;
  onDetailResizeStart?: (event: React.MouseEvent) => void;
  onDetailResizeKeyDown?: (event: React.KeyboardEvent) => void;
  workspaceIssues?: any[];
  inspectorView: InspectorPanelView;
  onSelectInspectorView?: (view: InspectorPanelView) => void;
  onDetachWorkspaceTools?: () => void;
  canDetachWorkspaceTools?: boolean;
}

export const InspectorArea = (props: InspectorAreaProps) => {
  const {
    selectedActionIds,
    sceneData,
    setSelectedIds,
    detailOpen,
    onDetailOpen,
    onDetailClose,
    layoutMode,
    navigatorWidth,
    detailWidth,
    onDetailResizeStart,
    onDetailResizeKeyDown,
  } = props;
  const editorStore = useApp().stores.editor;
  const documentStore = useDocumentStore();
  const semanticAuthoring = useSemanticAuthoringService();
  const { settings } = useSettings();
  const isTracksMode = settings.workbenchTimelineLayoutMode === 'tracks';

  if (isTracksMode) {
    return <PropertyInspectorShell {...props} />;
  }
  const templateCatalog = useTemplatePackageCatalog();
  const templatePackageSnapshot = useSyncExternalStore(
    templateCatalog ? (listener) => templateCatalog.subscribe(listener) : () => () => {},
    templateCatalog ? () => templateCatalog.getPackages() : getStableEmptyPackages,
    getStableEmptyPackages,
  );
  const availableTemplates = useMemo(
    () => {
      // The external-store snapshot invalidates this memo when packages change;
      // the catalog remains the source of truth for combo derivation.
      void templatePackageSnapshot;
      return templateCatalog?.getSemanticAuthoringCombos() ?? [];
    },
    [templateCatalog, templatePackageSnapshot],
  );
  const { document: semanticDocument } = useSemanticDocument();

  const detailSelectedActionIds = props.detailSelectedActionIds ?? selectedActionIds;
  const selectedIdsList = Object.keys(detailSelectedActionIds);
  const selectedCount = selectedIdsList.length;
  const firstId = selectedIdsList[0];
  const semanticTimelineItems = useMemo(
    () => buildSemanticTimelineReadModel(
      semanticDocument,
      documentStore.getCompiledSceneSnapshot(),
    ),
    [documentStore, semanticDocument],
  );
  const displayActions = useMemo(
    () => semanticTimelineItems.map((item) => item.displayAction),
    [semanticTimelineItems],
  );
  const selectedAction = useMemo(() => {
    if (!firstId) return undefined;
    return displayActions.find((action) => action._id === firstId)
      ?? resolveMatchingTimelineAction(displayActions, firstId);
  }, [displayActions, firstId]);
  const workspaceErrorCount = props.workspaceIssues?.filter((issue) => issue.severity === 'error').length ?? 0;
  const workspaceWarningCount = props.workspaceIssues?.filter((issue) => issue.severity === 'warning').length ?? 0;
  const handleDetailClose = async () => {
    const result = await props.handleSave();
    if (result && !result.success) return;
    onDetailClose();
  };

  const timelineList = (
    <TimelineListView
      sceneData={props.sceneData}
      selectedActionIds={props.selectedActionIds}
      setSelectedIds={props.setSelectedIds}
      addAction={props.addAction}
      handleSelect={(idOrIds, multi) => {
        onDetailOpen();
        props.handleSelect(idOrIds, multi);
      }}
      setCurrentTime={props.setCurrentTime}
      loadExample={props.loadExample}
      workspaceErrorCount={workspaceErrorCount}
      workspaceWarningCount={workspaceWarningCount}
      availableTemplates={availableTemplates}
      onSelectWorkspaceView={(tab) => props.onSelectInspectorView?.(tab)}
    />
  );

  const navigatorContent = props.inspectorView === 'actions' ? timelineList : (
    <ContextPanel
      sceneMeta={sceneData.meta}
      actionCount={semanticTimelineItems.length}
      globalIssues={props.workspaceIssues ?? []}
      action={selectedCount === 1 ? selectedAction : undefined}
      isOpen
      setIsOpen={(open) => {
        if (!open) props.onSelectInspectorView?.('actions');
      }}
      width={navigatorWidth}
      activeTab={props.inspectorView}
      setActiveTab={(tab) => props.onSelectInspectorView?.(tab)}
      onDetach={props.onDetachWorkspaceTools}
      canDetach={props.canDetachWorkspaceTools}
      embedded
    />
  );
  const navigator = (
    <div
      className="inspector-workspace__pane inspector-workspace__pane--navigator"
      data-timeline-layout={settings.workbenchTimelineLayoutMode}
      key={props.inspectorView}
    >
      {navigatorContent}
    </div>
  );

  if (
    !inspectorViewSupportsActionDetail(props.inspectorView)
    || selectedCount === 0
    || !detailOpen
  ) {
    if (layoutMode === 'split') {
      return (
        <div
          className="inspector-workspace"
          data-timeline-layout={settings.workbenchTimelineLayoutMode}
          data-state="closed"
        >
          <div key="navigator" className="inspector-workspace__navigator" style={{ width: navigatorWidth }}>
            {navigator}
          </div>
        </div>
      );
    }
    return navigator;
  }

  let detail: React.ReactNode;
  if (selectedCount === 1 && selectedAction) {
    detail = (
      <ActionInspector
        key={firstId}
        {...props}
        replaceSourceParams={props.replaceSourceParams ?? ((id, params) => props.updateAction(id, { params }))}
        selectedActionIds={detailSelectedActionIds}
        onClose={handleDetailClose}
        closeMode={layoutMode === 'split' ? 'close' : 'back'}
      />
    );
  } else {
    detail = (
      <div key={`multi-${selectedIdsList.join(':')}`} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-secondary)', flexShrink: 0
        }}>
          <button
            className="btn btn--icon"
            onClick={() => { void handleDetailClose(); }}
            title={layoutMode === 'split' ? '关闭详情' : '返回动作列表'}
            aria-label={layoutMode === 'split' ? '关闭详情' : '返回动作列表'}
          >
            {layoutMode === 'split' ? <IconX width={16} height={16} /> : <IconArrowLeft width={16} height={16} />}
          </button>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {selectedCount} 个动作已选中
          </span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          <div className="card" style={{
            padding: 20, textAlign: 'center',
            background: 'var(--accent-glow)',
            border: '1px solid var(--border-accent)',
            borderRadius: 'var(--radius-lg)',
            marginBottom: 16
          }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)' }}>
              {selectedCount}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>个动作已选中</div>
          </div>
          <button className="btn btn--danger" style={{ width: '100%', marginBottom: 8 }}
            onClick={async () => {
              if (props.deleteActions) {
                await props.deleteActions(selectedIdsList);
              } else if (semanticAuthoring) {
                const intents = buildSemanticDeleteTimelineIntents(documentStore, selectedIdsList);
                if (intents.length > 0) await semanticAuthoring.authorTransaction(intents);
                setSelectedIds({});
              }
            }}>
            <IconTrash width={14} height={14} /> 批量删除
          </button>
          <button className="btn" style={{ width: '100%' }}
            onClick={() => {
              if (props.copyActions) {
                props.copyActions(selectedIdsList);
              } else {
                const statements = buildSemanticCopyBufferForTimelineActions(documentStore, selectedIdsList);
                if (statements.length > 0) editorStore.setCopyBuffer(statements);
              }
            }}>
            <IconCopy width={14} height={14} /> 复制到剪贴板
          </button>
        </div>
      </div>
    );
  }

  const animatedDetail = (
    <div
      className="inspector-workspace__pane inspector-workspace__pane--detail"
      data-layout={layoutMode}
      data-state={props.detailClosing ? 'closing' : 'open'}
    >
      {detail}
    </div>
  );

  if (layoutMode === 'replace') {
    return animatedDetail;
  }

  return (
    <div
      className="inspector-workspace"
      data-timeline-layout={settings.workbenchTimelineLayoutMode}
      data-state={props.detailClosing ? 'closing' : 'open'}
    >
      <div key="detail" className="inspector-workspace__detail" style={{ width: detailWidth }}>
        {animatedDetail}
      </div>
      <div
        key="resize"
        className="resize-handle inspector-workspace__resize"
        role="separator"
        aria-label="调整详情面板宽度"
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={480}
        aria-valuenow={detailWidth}
        tabIndex={0}
        onMouseDown={onDetailResizeStart}
        onKeyDown={onDetailResizeKeyDown}
      />
      <div key="navigator" className="inspector-workspace__navigator" style={{ width: navigatorWidth }}>
        {navigator}
      </div>
    </div>
  );
};

const stableEmptyPackages: never[] = [];
const getStableEmptyPackages = () => stableEmptyPackages;
