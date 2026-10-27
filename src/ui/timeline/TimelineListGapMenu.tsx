import { useMemo, useRef, useState } from 'react';
import { useDocumentStore } from '../context/AppContext';
import { IconPlus } from '../icons';
import type { TimelineScene } from './semanticTimelineTypes';
import type { SemanticTimelineSnapshot } from './useSemanticTimelineSnapshot';
import type { SourcedSemanticAuthoringCombo } from '../../services/template-package';
import { StatementLibraryMenu } from './StatementLibraryMenu';
import { prepareSemanticStatementLibraryMenu, type SemanticStatementLibraryInsertOptions } from './semanticStatementInsertion';
import { buildTimelineListGaps, type TimelineListGap } from './timelineListGaps';
import type { TimelineListEditing } from './useTimelineListEditing';
import type { TimelineStatementRowCommands } from './TimelineStatementRow';

export function useTimelineListGapMenu(sceneData: TimelineScene, snapshot: SemanticTimelineSnapshot) {
  const documentStore = useDocumentStore();
  const semanticTimelineItems = snapshot.items;
  const gapInsertPendingRef = useRef(false);
  const [activeGapMenu, setActiveGapMenu] = useState<{ gap: TimelineListGap; x: number; y: number } | null>(null);
  const gapInsertOptions = useMemo<Omit<SemanticStatementLibraryInsertOptions, 'blockId'> | null>(() => {
    if (!activeGapMenu) return null;
    const { gap } = activeGapMenu;
    const nextRootStatement = semanticTimelineItems
      .slice(gap.index + 1)
      .find((item) => item.locator.kind === 'statement');
    const prevSpeakerId = gap.previous.source.type === 'dialogue' && typeof gap.previous.displayAction.params?.speaker === 'string'
      ? gap.previous.displayAction.params.speaker
      : undefined;
    const charId = prevSpeakerId || sceneData.meta.characters?.[0]?.id;
    return {
      document: documentStore.getCurrentSceneDocumentSnapshot(),
      sceneMeta: sceneData.meta,
      anchorTime: gap.time,
      origin: 'timeline-list-gap',
      scope: charId
        ? prevSpeakerId
          ? { kind: 'inferred-character', charId, source: 'blank-menu-track' }
          : { kind: 'character', charId }
        : { kind: 'none' },
      lightingTarget: { kind: 'scene' },
      correlationPrefix: 'timeline_list_gap_insert',
      lifecycleEndCorrelationPrefix: 'timeline_list_gap_lifecycle_end',
      lifecycleTargetBindingCorrelationPrefix: 'timeline_list_gap_lifecycle_target_binding',
      beforeStatementId: nextRootStatement?.statementId,
    };
  }, [activeGapMenu, documentStore, sceneData.meta, semanticTimelineItems]);
  const statementCommands = useMemo(() => gapInsertOptions
    ? prepareSemanticStatementLibraryMenu(gapInsertOptions) : null, [gapInsertOptions]);
  const availableLifecycleEndCommandIds = statementCommands?.availableLifecycleEndCommandIds ?? new Set<string>();
  const availableLifecycleTargetBindingCommandIds = statementCommands?.availableLifecycleTargetBindingCommandIds ?? new Set<string>();

  const gapContextMeta = useMemo(() => {
    if (!activeGapMenu) return undefined;
    const prev = activeGapMenu.gap.previous;
    const speakerId = prev.source.type === 'dialogue' && typeof prev.displayAction.params?.speaker === 'string'
      ? prev.displayAction.params.speaker
      : undefined;
    if (speakerId) {
      const speaker = sceneData.meta.characters?.find((character) => character.id === speakerId);
      return speaker?.name || speakerId;
    }
    return undefined;
  }, [activeGapMenu, sceneData.meta.characters]);
  const timelineListGaps = useMemo(
    () => buildTimelineListGaps(semanticTimelineItems),
    [semanticTimelineItems],
  );
  const timelineListGapByIndex = useMemo(
    () => new Map<number, TimelineListGap>(timelineListGaps.map((gap) => [gap.index, gap])),
    [timelineListGaps],
  );
  return {
    activeGapMenu, setActiveGapMenu, gapInsertPendingRef, timelineListGapByIndex,
    availableLifecycleEndCommandIds, availableLifecycleTargetBindingCommandIds, gapContextMeta, gapInsertOptions,
  };
}

export type TimelineListGapMenuState = ReturnType<typeof useTimelineListGapMenu>;

export function TimelineListGapMenu({ state, editing, templates }: {
  state: TimelineListGapMenuState;
  editing: TimelineListEditing;
  templates?: SourcedSemanticAuthoringCombo[];
}) {
  const { activeGapMenu, setActiveGapMenu, gapContextMeta,
    availableLifecycleEndCommandIds, availableLifecycleTargetBindingCommandIds } = state;
  return (
    <StatementLibraryMenu
      menu={activeGapMenu ? {
        x: activeGapMenu.x,
        y: activeGapMenu.y,
        time: activeGapMenu.gap.time,
        ...(gapContextMeta ? { contextMeta: gapContextMeta } : {}),
      } : null}
      hasCopyBuffer={editing.hasCopyBuffer}
      templates={templates}
      onPaste={editing.handlePasteAtGap}
      onSelectAction={editing.handleSelectActionFromLibrary}
      onDismiss={() => setActiveGapMenu(null)}
      dataTestId="timeline-blank-insert-menu"
      ariaLabel="时间轴插入语句菜单"
      availableLifecycleEndCommandIds={availableLifecycleEndCommandIds}
      availableStateSpanDependencyCommandIds={availableLifecycleTargetBindingCommandIds}
    />
  );
}

export function TimelineListGapControl({ gap, active, dragOver, draggingActionId, commands }: {
  gap: TimelineListGap;
  active: boolean;
  dragOver: boolean;
  draggingActionId: string | null;
  commands: Pick<TimelineStatementRowCommands, 'setActiveGapMenu' | 'gapInsertPendingRef'
    | 'setDragOverGapIndex' | 'setDropTarget' | 'blockOfflineAuthoring' | 'dropRootStatementAt'>;
}) {
  const { setActiveGapMenu, gapInsertPendingRef, setDragOverGapIndex, setDropTarget, blockOfflineAuthoring } = commands;
  return (
    <div
      className={`timeline-list-gap ${dragOver ? 'timeline-list-gap--drag-over' : ''}`}
      data-testid="timeline-list-gap"
      data-active={active}
      onDragOver={(event) => {
        if (!draggingActionId) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setDragOverGapIndex(gap.index);
        setDropTarget(null);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragOverGapIndex((current) => (current === gap.index ? null : current));
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const currentDraggingId = draggingActionId;
        setDragOverGapIndex(null);
        setDropTarget(null);
        if (!currentDraggingId) return;
        void commands.dropRootStatementAt(currentDraggingId, gap.index + 1);
      }}
    >
      <button
        type="button"
        className="timeline-list-gap__button"
        tabIndex={-1}
        aria-label={`在 ${gap.time.toFixed(1)} 秒插入语句`}
        title={`在 ${gap.time.toFixed(1)} 秒插入语句`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (gapInsertPendingRef.current) return;
          if (blockOfflineAuthoring()) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = Math.max(12, rect.left - 424);
          const y = rect.top;
          setActiveGapMenu((current) => (current?.gap.index === gap.index ? null : { gap, x, y }));
        }}
      >
        <IconPlus width={11} height={11} aria-hidden="true" />
      </button>
    </div>
  );
}
