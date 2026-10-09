import React from 'react';
import { useCollaborationPresence } from '../context/AppContext';
import { IconPlay, IconTrash, IconUsers, IconGripVertical, IconChevronDown } from '../icons';
import { getPeersEditingLocator, summarizeLocatorEditingPeers } from '../../services/collaboration/CollaborationPresence';
import { BACKGROUND_LAYER_ID } from '../../engine/environmentLayerModel';
import { InlineNumericInput } from './FormComponents';
import { ActionInspector } from './ActionInspector';
import { StatementQuickControls } from './StatementQuickControls';
import { InlineStatementDetails } from './InlineStatementDetails';
import { ActionIcons } from './TimelineConstants';
import { type collectEnvironmentLayerPresentations, getEnvironmentActionLayerId } from './environmentPresentation';
import { TimelineListGapControl, type TimelineListGapMenuState } from './TimelineListGapMenu';
import type { TimelineListEditing } from './useTimelineListEditing';
import type { TimelineListExpansion } from './useTimelineListExpansion';
import type { TimelineListViewProps } from './TimelineListView';
import type { SemanticTimelineSnapshot } from './useSemanticTimelineSnapshot';
import type { TimelineAction } from './semanticTimelineTypes';

function getTimelineItemClassForSemanticCategory(category: TimelineAction['semanticCategory']): string {
  switch (category) {
    case 'dialogue':
      return 'timeline-item--dialogue';
    case 'character':
      return 'timeline-item--character';
    case 'camera':
      return 'timeline-item--camera';
    case 'audio':
      return 'timeline-item--audio';
    default:
      return 'timeline-item--environment';
  }
}

function isStatementRowSurface(event: React.SyntheticEvent<HTMLElement>) {
  const target = event.target;
  return target instanceof Element && event.currentTarget.contains(target) && !target.closest(
    'input, textarea, select, a, label, button:not(.timeline-item__select-button), '
    + '[role="button"], [role="combobox"], [role="spinbutton"], [contenteditable="true"], .timeline-item__time',
  );
}

function clearStatementRowPress(event: React.SyntheticEvent<HTMLElement>) {
  delete event.currentTarget.dataset.pressed;
}

function preserveInlineDraftFocus(event: React.MouseEvent<HTMLElement>) {
  const controls = event.currentTarget.closest('.timeline-item')?.querySelector('.timeline-item__inline-controls');
  // Opening this row should not blur its draft or interrupt native text composition.
  if (controls?.contains(document.activeElement)) event.preventDefault();
}

interface TimelineStatementRowProps {
  action: TimelineAction;
  realIdx: number;
  view: Pick<TimelineListViewProps, 'sceneData' | 'handleSelect' | 'setSelectedIds' | 'selectedActionIds'>;
  semanticSnapshot: SemanticTimelineSnapshot;
  environmentLayers: ReturnType<typeof collectEnvironmentLayerPresentations>;
  allowInlineExpand: boolean;
  searchQuery: string;
  expansion: TimelineListExpansion;
  editing: TimelineListEditing;
  gapMenu: TimelineListGapMenuState;
}

export function TimelineStatementRow({ action, realIdx, view, semanticSnapshot,
  environmentLayers, allowInlineExpand, searchQuery, expansion, editing, gapMenu }: TimelineStatementRowProps) {
  const { sceneData, handleSelect, setSelectedIds } = view;
  const { expandedActionIds, revealedActionId, automaticallyExpandedActionId,
    manuallyExpandedActionIds, toggleExpand } = expansion;
  const { draggingActionId, dropTarget, setDropTarget, setDragOverGapIndex, setDraggingActionId,
    dropRootStatementAt, isOfflineEditingBlocked, handleTimeEdit, handleDeleteItem, commitInlineParams } = editing;
  const { peers: collaborationPeers } = useCollaborationPresence();
  const isSelected = !!action._id && !!view.selectedActionIds[action._id];
  const isExpanded = !!action._id && !!expandedActionIds[action._id];
  const readModelItem = action._id
    ? semanticSnapshot.itemById.get(action._id)
    : undefined;
  const presenceLocator = readModelItem?.locator;
  const editingPeers = presenceLocator
    ? getPeersEditingLocator(collaborationPeers, presenceLocator)
    : [];
  const collaborationEditingSummary = presenceLocator
    ? summarizeLocatorEditingPeers(collaborationPeers, presenceLocator)
    : null;
  let title: string = action.semanticLabel ?? action.action;
  let typeClass = getTimelineItemClassForSemanticCategory(action.semanticCategory);
  const environmentLayerId = getEnvironmentActionLayerId(action);
  const environmentLayer = environmentLayerId ? environmentLayers.get(environmentLayerId) : null;
  const gap = !searchQuery.trim() ? gapMenu.timelineListGapByIndex.get(realIdx) : undefined;
  const canDragRootStatement = !searchQuery.trim() && readModelItem?.locator.kind === 'statement';
  const IconComp = (ActionIcons as any)[action.semanticIconKey ?? action.action] || ActionIcons.default;

  if (action.semanticType === 'filterAdd') {
    title = '添加滤镜';
    typeClass = 'timeline-item--environment';
  } else if (action.semanticType === 'filterChange') {
    title = '变化滤镜';
    typeClass = 'timeline-item--environment';
  } else if (action.semanticType === 'filterReset') {
    title = '重置滤镜';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'dialogue') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.speakerId);
    title = char ? char.name : (action.params.speaker || action.params.speakerId || '旁白');
    typeClass = 'timeline-item--dialogue';
  } else if (action.action === 'characterPerformance' && !action.params.motion) {
    const targetCharId = action.resolvedSpeakerId ?? action.params.target;
    const char = sceneData.meta.characters?.find(c => c.id === targetCharId);
    title = `${char ? char.name : (targetCharId || '未知角色')} · 动作待定`;
    typeClass = 'timeline-item--character timeline-item--placeholder';
  } else if (action.action === 'playMotion') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
    title = `${char ? char.name : (action.params.id || '未知角色')} · 播放动作`;
    typeClass = 'timeline-item--character';
  } else if (action.action === 'setExpression') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
    title = `${char ? char.name : (action.params.id || '未知角色')} · 设置表情`;
    typeClass = 'timeline-item--character';
  } else if (action.action === 'transformCharacter') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
    title = `${char ? char.name : (action.params.id || '未知角色')} · 变换角色`;
    typeClass = 'timeline-item--character';
  } else if (action.action === 'addCharacter') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
    title = `${char ? char.name : (action.params.id || '未知角色')} · 角色登场`;
    typeClass = 'timeline-item--character';
  } else if (action.action === 'removeCharacter') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
    title = `${char ? char.name : (action.params.id || '未知角色')} · 角色退场`;
    typeClass = 'timeline-item--character';
  } else if (action.action === 'characterLookAt') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
    title = `${char ? char.name : (action.params.id || '未知角色')} · 角色对焦`;
    typeClass = 'timeline-item--character';
  } else if (action.action === 'characterBlink') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
    title = `${char ? char.name : (action.params.id || '未知角色')} · 角色眨眼`;
    typeClass = 'timeline-item--character';
  } else if (action.action === 'setCharacterRimLight') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.id);
    title = `${char ? char.name : (action.params.id || '未知角色')} · 角色边光`;
    typeClass = 'timeline-item--character';
  } else if (action.action === 'cameraPath') {
    title = '镜头路径运动';
    typeClass = 'timeline-item--camera';
  } else if (action.action === 'cameraShake') {
    title = '镜头震动';
    typeClass = 'timeline-item--camera';
  } else if (action.action === 'cameraFollow') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.characterId);
    title = `镜头跟随 · ${char ? char.name : (action.params.characterId || '未知角色')}`;
    typeClass = 'timeline-item--camera';
  } else if (action.action === 'cameraHitchcock') {
    const char = sceneData.meta.characters?.find(c => c.id === action.params.characterId);
    title = `希区柯克变焦 · ${char ? char.name : (action.params.characterId || '未知角色')}`;
    typeClass = 'timeline-item--camera';
  } else if (action.action === 'cameraMotion') {
    title = '运镜动作';
    typeClass = 'timeline-item--camera';
  } else if (action.action === 'cameraReset') {
    title = '重置镜头';
    typeClass = 'timeline-item--camera';
  } else if (action.action === 'setEnvironmentLayer') {
    const layerId = action.params.layerId || BACKGROUND_LAYER_ID;
    title = layerId === BACKGROUND_LAYER_ID ? '放入背景' : `放入环境画面 · ${environmentLayer?.displayLabel || '环境层'}`;
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'transformEnvironmentLayer') {
    const layerId = action.params.layerId || BACKGROUND_LAYER_ID;
    title = layerId === BACKGROUND_LAYER_ID ? '调整背景' : `调整环境画面 · ${environmentLayer?.displayLabel || '环境层'}`;
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'removeEnvironmentLayer') {
    const layerId = action.params.layerId || BACKGROUND_LAYER_ID;
    title = layerId === BACKGROUND_LAYER_ID ? '收起背景' : `收起环境画面 · ${environmentLayer?.displayLabel || '环境层'}`;
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'setCompositeRecipe') {
    title = action.params.slot === 'grounding' ? '设置角色明暗融入' : action.params.slot === 'integration' ? '设置角色色彩融入' : '设置角色融入';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'modulateComposite') {
    title = action.params.slot === 'grounding' ? '变化角色明暗融入' : action.params.slot === 'integration' ? '变化角色色彩融入' : '变化角色融入';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'resetCompositeRecipe') {
    title = action.params.slot === 'grounding' ? '重置角色明暗融入' : action.params.slot === 'integration' ? '重置角色色彩融入' : '重置角色融入';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'setLighting') {
    title = '设置光照预设';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'resetLighting') {
    title = '重置光照';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'setBlur') {
    title = '设置模糊';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'resetBlur') {
    title = '重置模糊';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'setGodrays') {
    title = '设置体积光';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'resetGodrays') {
    title = '重置体积光';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'setPostProcessing') {
    title = '设置后期处理';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'resetPostProcessing') {
    title = '重置后处理';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'addColorOverlay') {
    title = '添加色彩叠加';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'removeColorOverlay') {
    title = '移除色彩叠加';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'clearColorOverlays') {
    title = '清除全部色彩叠加';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'addPointLight') {
    title = '添加点光源';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'clearPointLights') {
    title = '清除全部点光源';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'removePointLight') {
    title = '移除点光源';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'addImage') {
    title = '添加图片';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'transformImage') {
    title = '变换图片';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'removeImage') {
    title = '移除图片';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'addTextLayer') {
    title = '添加文本图层';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'transformTextLayer') {
    title = '变换文本图层';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'removeTextLayer') {
    title = '移除文本图层';
    typeClass = 'timeline-item--environment';
  } else if (action.action === 'playAudio') {
    title = '播放音频';
    typeClass = 'timeline-item--audio';
  } else if (action.action === 'stopAudio') {
    title = '停止音频';
    typeClass = 'timeline-item--audio';
  } else if (action.action === 'setBGM') {
    title = '设置背景音乐';
    typeClass = 'timeline-item--audio';
  } else if (action.action === 'playCustomAnimation') {
    title = '自定义动画';
    typeClass = 'timeline-item--environment';
  }

  const isDragging = !!draggingActionId && (
    draggingActionId === readModelItem?.statementId ||
    (!!action._id && draggingActionId === action._id)
  );
  const isDropBefore = !isDragging && dropTarget?.index === realIdx && dropTarget.placement === 'before';
  const isDropAfter = !isDragging && dropTarget?.index === realIdx && dropTarget.placement === 'after';

  return (
    <div key={action._id ?? `timeline-item:${realIdx}`} className={`timeline-item-container ${action._id === revealedActionId ? 'timeline-item-container--revealed' : ''} ${!allowInlineExpand ? 'timeline-item-container--compact' : ''}`} style={{ position: 'relative' }}>
      <div
        className={`timeline-item ${typeClass} ${isSelected && !allowInlineExpand ? 'timeline-item--active' : ''} ${isExpanded && allowInlineExpand ? 'timeline-item--expanded' : ''} ${action._id === revealedActionId ? 'timeline-item--revealed' : ''} ${collaborationEditingSummary ? 'timeline-item--collaboration-editing' : ''} ${isDragging ? 'timeline-item--dragging' : ''} ${isDropBefore ? 'timeline-item--drop-before' : ''} ${isDropAfter ? 'timeline-item--drop-after' : ''} ${!allowInlineExpand ? 'timeline-item--compact' : 'timeline-item--authoring'}`}
        onClick={(event) => {
          if (!isStatementRowSurface(event)) return;
          clearStatementRowPress(event);
          const multi = event.ctrlKey || event.metaKey;
          if (allowInlineExpand && !multi) toggleExpand(action._id!);
          else handleSelect(action._id!, multi);
        }}
        onMouseDown={(event) => {
          if (isStatementRowSurface(event)) preserveInlineDraftFocus(event);
        }}
        onPointerDown={(event) => {
          if (event.button === 0 && isStatementRowSurface(event)) event.currentTarget.dataset.pressed = 'true';
        }}
        onPointerUp={clearStatementRowPress}
        onPointerCancel={clearStatementRowPress}
        onPointerLeave={clearStatementRowPress}
        onDragOver={(event) => {
          if (!draggingActionId || searchQuery.trim()) return;
          if (isDragging) {
            setDropTarget(null);
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          const placement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          setDropTarget((current) => {
            if (current?.index === realIdx && current?.placement === placement) return current;
            return { index: realIdx, placement };
          });
          setDragOverGapIndex(null);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setDropTarget((current) => (current?.index === realIdx ? null : current));
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const currentDraggingId = draggingActionId;
          setDropTarget(null);
          setDragOverGapIndex(null);
          if (!currentDraggingId || searchQuery.trim()) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const insertAfter = event.clientY >= rect.top + rect.height / 2;
          void dropRootStatementAt(currentDraggingId, realIdx + (insertAfter ? 1 : 0));
        }}
        role="group"
        aria-label={`${title}${action.action === 'dialogue' && action.params?.text ? `，${action.params.text}` : ''}，时间 ${(action.time || 0).toFixed(1)} 秒${isSelected ? '，已选中' : ''}`}
        title={collaborationEditingSummary || undefined}
      >
        <div className="timeline-item__identity">
          {canDragRootStatement ? (
            <button
              type="button"
              className={`timeline-item__drag-handle ${isDragging ? 'timeline-item__drag-handle--dragging' : ''}`}
              draggable
              style={{ background: isSelected ? 'rgba(255,255,255,0.08)' : 'var(--bg-surface)' }}
              title="拖拽调整语句顺序"
              aria-label={`拖拽第 ${realIdx + 1} 行调整语句顺序`}
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => {
                if (!readModelItem || readModelItem.locator.kind !== 'statement') {
                  event.preventDefault();
                  return;
                }
                event.stopPropagation();
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', readModelItem.statementId);
                setDraggingActionId(readModelItem.statementId);
                setDropTarget(null);
                setDragOverGapIndex(null);
              }}
              onDragEnd={() => {
                setDraggingActionId(null);
                setDropTarget(null);
                setDragOverGapIndex(null);
              }}
            >
              <span className="timeline-item__type-glyph" aria-hidden="true">
                <IconComp width={15} height={15} />
              </span>
              <IconGripVertical className="timeline-item__grip-glyph" width={15} height={15} aria-hidden="true" />
            </button>
          ) : (
            <div
              className="timeline-item__type-icon"
              aria-hidden="true"
              style={{ background: isSelected ? 'rgba(255,255,255,0.08)' : 'var(--bg-surface)' }}
            >
              <IconComp width={15} height={15} />
            </div>
          )}
          <div className="timeline-item__time" title="编辑时间" onClick={(event) => event.stopPropagation()}>
            <InlineNumericInput value={action.time || 0} step="0.1" min="0" popoverMin="0" popoverMax="60"
              ariaLabel={`${title}开始时间`} disabled={isOfflineEditingBlocked}
              onChange={(value, transient) => { if (!transient) handleTimeEdit(value, action._id!); }} />
          </div>
        </div>

        {allowInlineExpand && (
          <button
            type="button"
            className={`timeline-item__expand-btn ${isExpanded ? 'timeline-item__expand-btn--expanded' : ''}`}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? '折叠详情' : '展开详情'}
            title={isExpanded ? '折叠详情' : '展开详情'}
            onMouseDown={preserveInlineDraftFocus}
            onClick={(event) => {
              event.stopPropagation();
              toggleExpand(action._id!);
            }}
          >
            <span className="timeline-item__expand-indicator"><IconChevronDown width={13} height={13} /></span>
          </button>
        )}

        <button
          type="button"
          className="timeline-item__select-button"
          aria-label={allowInlineExpand ? `${isExpanded ? '折叠' : '展开'}${title}详情` : `选择${title}${isSelected ? '，当前已选中' : ''}`}
          aria-expanded={allowInlineExpand ? isExpanded : undefined}
          aria-pressed={allowInlineExpand ? undefined : isSelected}
        >
          <div className="timeline-item__title-row">
            <div className="timeline-item__title">{title}</div>
            {collaborationEditingSummary && (
              <span
                className="timeline-item__collaboration-badge"
                title={collaborationEditingSummary}
                aria-label={collaborationEditingSummary}
              >
                <IconUsers width={11} height={11} />
                <span>{editingPeers.length}</span>
              </span>
            )}
          </div>
          {environmentLayer && (
            <div className="timeline-item__layer-label" style={allowInlineExpand ? { display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' } : undefined}>
              <span className="timeline-item__layer-tag">
                {environmentLayer.isBackground ? '主背景' : environmentLayer.displayLabel}
              </span>
            </div>
          )}
        </button>

        {allowInlineExpand && (
          <div className="timeline-item__inline-controls">
            {readModelItem && (
              <StatementQuickControls item={readModelItem} sceneData={sceneData} timelineActions={semanticSnapshot.actions}
                expanded={isExpanded}
                disabled={isOfflineEditingBlocked} onChange={(patch) => commitInlineParams(action, patch)} />
            )}
          </div>
        )}

        <div className="timeline-item__actions">
          <button
            className="timeline-item__action-btn timeline-item__action-btn--play"
            onClick={(event) => {
              event.stopPropagation();
              editing.playAction(action.time || 0);
            }}
            title="播放到此句"
            aria-label="播放到此句"
          >
            <IconPlay width={13} height={13} />
          </button>
          <button
            className="timeline-item__action-btn timeline-item__action-btn--delete"
            onClick={(event) => { void handleDeleteItem(event, action._id!); }}
            title="删除语句"
            aria-label="删除语句"
          >
            <IconTrash width={13} height={13} />
          </button>
        </div>
      </div>

      {allowInlineExpand && (
        <InlineStatementDetails expanded={isExpanded}
          animateExpansion={automaticallyExpandedActionId !== action._id || !!manuallyExpandedActionIds[action._id!]}>
          <ActionInspector
            key={action._id}
            semanticSnapshot={semanticSnapshot}
            sceneData={sceneData}
            presentation="inline"
            selectedActionIds={{ [action._id!]: true }}
            setSelectedIds={setSelectedIds}
            updateAction={(_id, updates) => {
              if (updates.params) commitInlineParams(action, updates.params, true);
            }}
            updateParam={(_id, key, val) => {
              commitInlineParams(action, { [key]: val });
            }}
            replaceSourceParams={(_id, params) => { commitInlineParams(action, params, true); }}
            deleteAction={(id) => { void editing.deleteActions([id]); }}
            copyActions={editing.copyActions}
            onClose={() => toggleExpand(action._id!)}
            closeMode="close"
          />
        </InlineStatementDetails>
      )}

      {gap && <TimelineListGapControl gap={gap} state={gapMenu} editing={editing} />}
    </div>
  );
}
