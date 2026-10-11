import React, { useState, useMemo } from 'react';
import { IconPlus, IconTrash, IconPlay, IconUndo, IconRedo, IconSearch,
  IconX, IconSelectLeft, IconSelectRight, IconCopy } from '../icons';
import type { WorkspaceToolTab } from '../workspace-tools/types';
import type { SourcedSemanticAuthoringCombo } from '../../services/template-package';
import { InspectorViewPicker } from './InspectorViewPicker';
import { MeasuredTimelineRow } from './useVirtualTimelineRows';
import { TimelineStatementRow, useTimelineStatementRowCommands } from './TimelineStatementRow';
import { TimelineListGapMenu, useTimelineListGapMenu } from './TimelineListGapMenu';
import { useTimelineListEditing } from './useTimelineListEditing';
import { useTimelineListExpansion } from './useTimelineListExpansion';
import { collectEnvironmentLayerPresentations, getEnvironmentActionLayerId } from './environmentPresentation';
import { useSettings } from '../SettingsStore';
import { useSemanticTimelineSnapshot, type SemanticTimelineSnapshot } from './useSemanticTimelineSnapshot';
import type { TimelineScene } from './semanticTimelineTypes';

function motionKeyLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const candidate = value as { kind?: unknown; key?: unknown };
    if (candidate.kind === 'resource' && typeof candidate.key === 'string') return candidate.key;
    if (candidate.kind === 'custom') return '自定义动作';
  }
  return '';
}

export interface TimelineListViewProps {
  semanticSnapshot?: SemanticTimelineSnapshot;
  sceneData: TimelineScene;
  inlineExpandable?: boolean;
  selectedActionIds: Record<string, boolean>;
  setSelectedIds: (ids: Record<string, boolean>) => void;
  addAction: () => void;
  handleSelect: (idOrIds: string | string[], multi?: boolean) => void;
  setCurrentTime: (t: number) => void;
  loadExample: () => Promise<boolean>;
  workspaceErrorCount?: number;
  workspaceWarningCount?: number;
  availableTemplates?: SourcedSemanticAuthoringCombo[];
  onSelectWorkspaceView?: (tab: WorkspaceToolTab) => void;
}

export const TimelineListView: React.FC<TimelineListViewProps> = (props) => {
  const {
    sceneData,
    addAction,
    loadExample,
    workspaceErrorCount = 0,
    workspaceWarningCount = 0,
    onSelectWorkspaceView,
  } = props;

  const semanticSnapshot = useSemanticTimelineSnapshot(props.semanticSnapshot);
  const { items: semanticTimelineItems, actions: semanticTimelineActions } = semanticSnapshot;
  const { settings, setSetting } = useSettings();
  const dialogueFlowEnabled = settings.workbenchDialogueFlowMode === 'auto';
  const isTracksMode = settings.workbenchTimelineLayoutMode === 'tracks';
  const allowInlineExpand = props.inlineExpandable ?? (!isTracksMode);

  const [searchQuery, setSearchQuery] = useState('');
  const characterCount = sceneData.meta.characters?.length ?? 0;
  const charactersById = useMemo(
    () => new Map((sceneData.meta.characters || []).map((character) => [character.id, character])),
    [sceneData.meta.characters],
  );

  const environmentLayers = useMemo(
    () => collectEnvironmentLayerPresentations(sceneData),
    [sceneData],
  );
  const timelineReadModelActions = semanticTimelineActions;
  const timelineItemCount = semanticTimelineItems.length;
  // ── Filter actions by search ────────────────────────────
  const filteredActions = useMemo(() => {
    const actions = timelineReadModelActions;

    if (!searchQuery.trim()) return actions;

    const q = searchQuery.toLowerCase();
    return actions.filter(a => {
      if (a.action.toLowerCase().includes(q)) return true;
      if (a.params.text && String(a.params.text).toLowerCase().includes(q)) return true;
      if (a.params.speaker && String(a.params.speaker).toLowerCase().includes(q)) return true;
      if (a.params.motion && String(motionKeyLabel(a.params.motion)).toLowerCase().includes(q)) return true;
      // ADR-0022: $speaker performance placeholders carry no runtime id —
      // match the read-model-resolved speaker and the source target too, so
      // searching the auto-bound character name finds the 动作待定 block.
      // The literal $speaker token must not shadow the resolved speaker.
      const rawTarget = a.params.target;
      const charId = a.params.id || a.params.speakerId
        || (rawTarget && rawTarget !== '$speaker' ? rawTarget : undefined)
        || a.resolvedSpeakerId;
      if (charId) {
        const char = charactersById.get(String(charId));
        if (char && char.name.toLowerCase().includes(q)) return true;
      }
      const environmentLayerId = getEnvironmentActionLayerId(a);
      if (environmentLayerId) {
        const presentation = environmentLayers.get(environmentLayerId);
        if (presentation?.displayLabel.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [charactersById, environmentLayers, searchQuery, timelineReadModelActions]);

  const gapMenu = useTimelineListGapMenu(sceneData, semanticSnapshot);
  const editing = useTimelineListEditing(props, semanticSnapshot, gapMenu);
  const expansion = useTimelineListExpansion(filteredActions, props.selectedActionIds, allowInlineExpand);
  const { listContainerRef, selectedIdsList, virtualRows, virtualRowSizes,
    handleExpandAll, handleCollapseAll } = expansion;
  const { setDropTarget, setDragOverGapIndex, handleSelectLeft, handleSelectRight,
    handleUndo, handleRedo, collaborationUndoDisabled, isOfflineEditingBlocked } = editing;
  // Geometry and row-local state change frequently; command identities do not.
  const rowCommands = useTimelineStatementRowCommands({
    handleSelect: props.handleSelect, setSelectedIds: props.setSelectedIds,
    toggleExpand: expansion.toggleExpand,
    setDropTarget, setDragOverGapIndex, setDraggingActionId: editing.setDraggingActionId,
    dropRootStatementAt: editing.dropRootStatementAt,
    handleTimeEdit: editing.handleTimeEdit, handleDeleteItem: editing.handleDeleteItem,
    commitInlineParams: editing.commitInlineParams, playAction: editing.playAction,
    deleteActions: editing.deleteActions, copyActions: editing.copyActions,
    blockOfflineAuthoring: editing.blockOfflineAuthoring,
    setActiveGapMenu: gapMenu.setActiveGapMenu, gapInsertPendingRef: gapMenu.gapInsertPendingRef,
  });
  const searchActive = !!searchQuery.trim();

  return (
    <div className={`timeline-list-view${allowInlineExpand ? '' : ' timeline-list-view--outline'}`} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar */}
      <div className="timeline-toolbar">
        <InspectorViewPicker
          activeView="actions"
          actionCount={timelineItemCount}
          characterCount={characterCount}
          errorCount={workspaceErrorCount}
          warningCount={workspaceWarningCount}
          onSelect={(view) => {
            if (view !== 'actions') onSelectWorkspaceView?.(view);
          }}
        />
        <div className="timeline-segmented-control" role="group" aria-label="对白自动重排模式">
          <button
            type="button"
            aria-pressed={dialogueFlowEnabled}
            data-active={dialogueFlowEnabled}
            onClick={() => setSetting('workbenchDialogueFlowMode', 'auto')}
          >
            全自动
          </button>
          <button
            type="button"
            aria-pressed={!dialogueFlowEnabled}
            data-active={!dialogueFlowEnabled}
            onClick={() => setSetting('workbenchDialogueFlowMode', 'manual')}
          >
            不自动重排
          </button>
        </div>
        {allowInlineExpand && (
          <div className="timeline-expand-controls" role="group" aria-label="展开控制">
            <button
              type="button"
              className="btn btn--sm"
              onClick={handleExpandAll}
              title="全部展开"
              aria-label="全部展开"
            >
              全部展开
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={handleCollapseAll}
              title="全部折叠"
              aria-label="全部折叠"
            >
              全部折叠
            </button>
          </div>
        )}
        {selectedIdsList.length > 1 && (
          <div className="timeline-toolbar__selection" role="group" aria-label="批量操作">
            <button type="button" className="btn btn--icon" aria-label="复制到剪贴板" title="复制选中语句"
              onClick={() => {
                editing.copyActions(selectedIdsList);
              }}><IconCopy width={14} height={14} /></button>
            <button type="button" className="btn btn--icon" aria-label="批量删除" title="删除选中语句" disabled={isOfflineEditingBlocked}
              onClick={async () => {
                await editing.deleteActions(selectedIdsList);
              }}><IconTrash width={14} height={14} /></button>
          </div>
        )}
        <div className="timeline-toolbar__spacer" />
        <button
          type="button"
          className="btn btn--icon"
          onClick={handleUndo}
          disabled={collaborationUndoDisabled}
          title={collaborationUndoDisabled ? '协作模式暂不支持撤销' : '撤销 (Ctrl+Z)'}
          aria-label={collaborationUndoDisabled ? '协作模式暂不支持撤销' : '撤销'}
        >
          <IconUndo width={16} height={16} />
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={handleRedo}
          disabled={collaborationUndoDisabled}
          title={collaborationUndoDisabled ? '协作模式暂不支持重做' : '重做 (Ctrl+Shift+Z)'}
          aria-label={collaborationUndoDisabled ? '协作模式暂不支持重做' : '重做'}
        >
          <IconRedo width={16} height={16} />
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--border-subtle)', margin: '0 4px' }} />
        <button type="button" className="btn btn--icon" onClick={handleSelectLeft} title="选中播放位置左侧所有动作" aria-label="选中播放位置左侧所有动作">
          <IconSelectLeft width={15} height={15} />
        </button>
        <button type="button" className="btn btn--icon" onClick={handleSelectRight} title="选中播放位置右侧所有动作" aria-label="选中播放位置右侧所有动作">
          <IconSelectRight width={15} height={15} />
        </button>
      </div>

      {/* Search */}
      <div className="timeline-list-search-container" style={{ padding: allowInlineExpand ? '0 12px 4px 12px' : '0 6px 4px' }}>
        <div className="timeline-search">
          <IconSearch width={14} height={14} className="timeline-search__icon" />
          <input
            type="text"
            aria-label="搜索时间轴动作、台词或角色"
            placeholder="搜索动作、台词、角色..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="清除搜索"
              title="清除搜索"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'flex' }}
            >
              <IconX width={12} height={12} />
            </button>
          )}
        </div>
      </div>

      {/* Empty state */}
      {!timelineItemCount && (
        <div style={{ padding: '0 12px 8px 12px' }}>
          <div className="card" style={{ padding: 24, textAlign: 'center', border: '1px dashed var(--border-default)', background: 'var(--bg-elevated)' }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>剧本时间轴为空</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>添加动作或加载示例剧本开始创作</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn btn--primary" onClick={addAction}><IconPlus width={14} height={14} /> 添加动作</button>
              <button className="btn" onClick={loadExample}><IconPlay width={14} height={14} /> 加载示例</button>
            </div>
          </div>
        </div>
      )}

      {searchQuery && filteredActions.length === 0 && timelineItemCount > 0 && (
        <div className="empty-state" style={{ flex: 0, padding: 24 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>未找到匹配 "{searchQuery}" 的动作</div>
        </div>
      )}

      {/* Timeline List */}
      {filteredActions.length > 0 && (
        <>
          <div className="timeline-list-header">
            <span>{searchQuery ? `搜索结果 (${filteredActions.length})` : `剧本时间轴 (${timelineItemCount} 项)`}</span>
            {selectedIdsList.length > 0 && (
              <span style={{ color: 'var(--accent-primary)', fontSize: 10 }}>
                已选 {selectedIdsList.length}
              </span>
            )}
          </div>

          <div
            className="timeline-list-scroll"
            ref={listContainerRef}
            onDragLeave={(event) => {
              if (listContainerRef.current && !listContainerRef.current.contains(event.relatedTarget as Node)) {
                setDropTarget(null);
                setDragOverGapIndex(null);
              }
            }}
            style={{
              flex: 1, overflowY: 'auto', padding: allowInlineExpand ? '0 8px 16px' : '0 8px 12px',
              position: 'relative', minHeight: 0, isolation: 'isolate', overflowAnchor: 'none'
            }}
          >
            <div ref={virtualRows.contentRef} className="timeline-list-items" style={{ position: 'relative', height: virtualRows.totalHeight }}>
              {virtualRows.indices.map((realIdx) => (
                <MeasuredTimelineRow key={virtualRowSizes[realIdx].id}
                  id={virtualRowSizes[realIdx].id} registerRow={virtualRows.registerRow}
                  measurementKey={virtualRowSizes[realIdx].measurementKey}
                  top={virtualRows.getOffset(realIdx)} gap={allowInlineExpand ? 6 : 4}
                  measure={virtualRows.measure}
                  onFocus={() => virtualRows.setFocusedId(virtualRowSizes[realIdx].id)}
                  onBlur={() => virtualRows.setFocusedId(null)}>
                  <TimelineStatementRow action={filteredActions[realIdx]} realIdx={realIdx}
                    sceneData={sceneData} semanticSnapshot={semanticSnapshot}
                    allowInlineExpand={allowInlineExpand}
                    searchActive={searchActive}
                    isSelected={!!props.selectedActionIds[virtualRowSizes[realIdx].id]}
                    isExpanded={!!expansion.expandedActionIds[virtualRowSizes[realIdx].id]}
                    isRevealed={expansion.revealedActionId === virtualRowSizes[realIdx].id}
                    animateExpansion={expansion.automaticallyExpandedActionId !== virtualRowSizes[realIdx].id
                      || !!expansion.manuallyExpandedActionIds[virtualRowSizes[realIdx].id]}
                    isOfflineEditingBlocked={isOfflineEditingBlocked}
                    draggingActionId={editing.draggingActionId}
                    dropPlacement={editing.dropTarget?.index === realIdx ? editing.dropTarget.placement : undefined}
                    gap={searchActive ? undefined : gapMenu.timelineListGapByIndex.get(realIdx)}
                    gapActive={gapMenu.activeGapMenu?.gap.index === realIdx}
                    gapDragOver={editing.dragOverGapIndex === realIdx}
                    commands={rowCommands} />
                </MeasuredTimelineRow>
              ))}
            </div>
          </div>
        </>
      )}

      <TimelineListGapMenu state={gapMenu} editing={editing} templates={props.availableTemplates} />
    </div>
  );
};
