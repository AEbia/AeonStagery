import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { ActionInspector } from './ActionInspector';
import { EngineSnapshotTab, DiagnosticsTab } from './ActionInspectorTabs';
import { CharacterDirectoryPanel } from './CharacterDirectoryPanel';
import {
  IconArrowLeft,
  IconTrash,
  IconCopy,
  IconFileText,
  IconActivity,
  IconLayers,
  IconX,
} from '../icons';
import type { TimelineScene } from './semanticTimelineTypes';
import type { InspectorPanelView } from './InspectorViewPicker';
import type { SaveResult } from '../../services/io/SceneFileService';
import {
  buildSemanticCopyBufferForTimelineActions,
  buildSemanticDeleteTimelineIntents,
} from './semanticTimelineEditing';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';
import { resolveMatchingTimelineAction } from './selectionHygiene';
import { useApp, useDocumentStore, useSemanticAuthoringService } from '../context/AppContext';
import { useSemanticDocument } from '../store/storeHooks';

const RawScriptTab = React.lazy(async () => {
  const module = await import('./RawScriptTab');
  return { default: module.RawScriptTab };
});

export interface PropertyInspectorShellProps {
  sceneData: TimelineScene;
  selectedActionIds: Record<string, boolean>;
  setSelectedIds: (ids: Record<string, boolean>) => void;
  inspectorTab?: 'basic' | 'transform' | 'state';
  setInspectorTab?: (t: 'basic' | 'transform' | 'state') => void;
  updateAction: (id: string, updates: any) => void;
  updateParam: (id: string, key: string, val: any) => void;
  replaceSourceParams?: (id: string, params: Record<string, unknown>) => void;
  deleteAction: (id: string) => void;
  deleteActions?: (ids: readonly string[]) => void | Promise<void>;
  copyActions?: (ids: readonly string[]) => void;
  addActionAt?: (time: number) => void;
  addAction?: () => void;
  handleSave: () => void | Promise<SaveResult | undefined>;
  handleSelect: (idOrIds: string | string[], multi?: boolean) => void;
  setCurrentTime: (t: number) => void;
  loadExample?: () => Promise<boolean>;
  detailOpen?: boolean;
  detailClosing?: boolean;
  detailSelectedActionIds?: Record<string, boolean>;
  onDetailOpen?: () => void;
  onDetailClose?: () => void;
  workspaceIssues?: any[];
  inspectorView?: InspectorPanelView;
  onSelectInspectorView?: (view: InspectorPanelView) => void;
  onDetachWorkspaceTools?: () => void;
  canDetachWorkspaceTools?: boolean;
}

export const PropertyInspectorShell: React.FC<PropertyInspectorShellProps> = (props) => {
  const editorStore = useApp().stores.editor;
  const documentStore = useDocumentStore();
  const semanticAuthoring = useSemanticAuthoringService();
  const { document: semanticDocument } = useSemanticDocument();

  const detailSelectedActionIds = props.selectedActionIds;
  const selectedIdsList = useMemo(
    () => Object.keys(detailSelectedActionIds).filter((id) => detailSelectedActionIds[id]),
    [detailSelectedActionIds],
  );
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

  const [internalView, setInternalView] = useState<InspectorPanelView>(props.inspectorView ?? 'actions');

  useEffect(() => {
    if (props.inspectorView !== undefined) {
      setInternalView(props.inspectorView);
    }
  }, [props.inspectorView]);

  const activeView = props.inspectorView ?? internalView;

  const { onSelectInspectorView } = props;
  const handleSwitchView = useCallback(
    (nextView: InspectorPanelView) => {
      setInternalView(nextView);
      onSelectInspectorView?.(nextView);
    },
    [onSelectInspectorView],
  );

  const prevSelectedIdRef = useRef<string | undefined>(firstId);
  useEffect(() => {
    if (activeView === 'diagnostics' && firstId && firstId !== prevSelectedIdRef.current) {
      handleSwitchView('actions');
    }
    prevSelectedIdRef.current = firstId;
  }, [firstId, activeView, handleSwitchView]);

  const handleDetailClose = async () => {
    const result = await props.handleSave();
    if (result && !result.success) return;
    props.setSelectedIds({});
    props.onDetailClose?.();
  };

  const isToolView = activeView !== 'actions';

  return (
    <div className="property-inspector-shell" data-timeline-layout="tracks">
      <div className="property-inspector-shell__toolbar">
        {isToolView ? (
          <>
            <button
              type="button"
              className="btn btn--sm btn--secondary property-inspector-shell__back-btn"
              onClick={() => handleSwitchView('actions')}
              title="返回属性检查器"
              aria-label="返回属性检查器"
            >
              <IconArrowLeft width={14} height={14} />
              <span>返回属性检查器</span>
            </button>
            <div className="property-inspector-shell__view-title">
              {activeView === 'script' && '场景 JSON'}
              {activeView === 'snapshot' && '运行快照'}
              {activeView === 'diagnostics' && '问题诊断'}
              {activeView === 'characters' && '角色管理'}
            </div>
            <div className="property-inspector-shell__tools">
              <button
                type="button"
                className={`btn btn--sm property-inspector-shell__tool-btn ${activeView === 'script' ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => handleSwitchView(activeView === 'script' ? 'actions' : 'script')}
                title="场景 JSON"
                aria-label="场景 JSON"
              >
                <IconFileText width={14} height={14} />
                <span>场景 JSON</span>
              </button>
              <button
                type="button"
                className={`btn btn--sm property-inspector-shell__tool-btn ${activeView === 'snapshot' ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => handleSwitchView(activeView === 'snapshot' ? 'actions' : 'snapshot')}
                title="运行快照"
                aria-label="运行快照"
              >
                <IconActivity width={14} height={14} />
                <span>运行快照</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="property-inspector-shell__header-left">
              <IconLayers width={15} height={15} />
              <span className="property-inspector-shell__title-text">属性检查器</span>
            </div>
            <div className="property-inspector-shell__tools">
              <button
                type="button"
                className="btn btn--sm btn--ghost property-inspector-shell__tool-btn"
                onClick={() => handleSwitchView('script')}
                title="场景 JSON"
                aria-label="场景 JSON"
              >
                <IconFileText width={14} height={14} />
                <span>场景 JSON</span>
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost property-inspector-shell__tool-btn"
                onClick={() => handleSwitchView('snapshot')}
                title="运行快照"
                aria-label="运行快照"
              >
                <IconActivity width={14} height={14} />
                <span>运行快照</span>
              </button>
            </div>
          </>
        )}
      </div>

      <div className="property-inspector-shell__content">
        {activeView === 'script' && (
          <div className="property-inspector-shell__tool-body" data-testid="raw-script-view">
            <React.Suspense fallback={<div className="empty-state" style={{ padding: 20, textAlign: 'center' }}>正在加载代码编辑器...</div>}>
              <RawScriptTab action={selectedAction} />
            </React.Suspense>
          </div>
        )}
        {activeView === 'snapshot' && (
          <div className="property-inspector-shell__tool-body" data-testid="engine-snapshot-view">
            <EngineSnapshotTab action={selectedAction} sceneMeta={props.sceneData.meta} />
          </div>
        )}
        {activeView === 'diagnostics' && (
          <div className="property-inspector-shell__tool-body" data-testid="diagnostics-view">
            <DiagnosticsTab globalIssues={props.workspaceIssues ?? []} />
          </div>
        )}
        {activeView === 'characters' && (
          <div className="property-inspector-shell__tool-body" data-testid="characters-view">
            <CharacterDirectoryPanel sceneMeta={props.sceneData.meta} />
          </div>
        )}
        {activeView === 'actions' && (
          selectedCount === 1 && selectedAction ? (
            <div className="property-inspector-shell__detail">
              <ActionInspector
                key={firstId}
                {...props}
                replaceSourceParams={props.replaceSourceParams ?? ((id, params) => props.updateAction(id, { params }))}
                selectedActionIds={detailSelectedActionIds}
                onClose={handleDetailClose}
                closeMode="close"
              />
            </div>
          ) : selectedCount > 1 ? (
            <div className="property-inspector-shell__multi" key={`multi-${selectedIdsList.join(':')}`}>
              <div className="property-inspector-shell__multi-header">
                <button
                  className="btn btn--icon"
                  onClick={() => { void handleDetailClose(); }}
                  title="取消选择"
                  aria-label="取消选择"
                >
                  <IconX width={16} height={16} />
                </button>
                <span>{selectedCount} 个动作已选中</span>
              </div>
              <div className="property-inspector-shell__multi-content">
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
                      if (intents.length !== 0) await semanticAuthoring.authorTransaction(intents);
                      props.setSelectedIds({});
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
                      if (statements.length !== 0) editorStore.setCopyBuffer(statements);
                    }
                  }}>
                  <IconCopy width={14} height={14} /> 复制到剪贴板
                </button>
              </div>
            </div>
          ) : (
            <div className="property-inspector-shell__empty" data-testid="property-inspector-empty">
              <div className="property-inspector-shell__empty-icon">
                <IconLayers width={36} height={36} />
              </div>
              <div className="property-inspector-shell__empty-title">
                未选中语句
              </div>
              <div className="property-inspector-shell__empty-desc">
                选择一个语句来查看属性
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
};
