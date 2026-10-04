import React, { useEffect, useState } from 'react';
import { useDocumentStore, usePlaybackAdapter } from '../../context/AppContext';
import { sceneStatementDefinitionRegistry } from '../../../services/semantic-scene';
import { AUTHORING_SCHEMA_VERSION } from '../../../api/types/authoring';
import {
  listAvailableLifecycleTargetBindingCommandIds,
  resolveLifecycleTargetBinding,
} from '../lifecycleTargetBinding';
import { SEMANTIC_STATEMENT_BLOCKS, type SemanticStatementBlockEntry } from '../semanticStatementBlocks';
import {
  createSemanticTimelineCorrelationId,
  selectCompiledActionsForStatements,
} from '../semanticTimelineEditing';
import type { TimelineScene } from '../semanticTimelineTypes';
import { IconPlus } from '../../icons';
import { showToast } from '../../Toast';
import type { ActionInspectorProps } from '../ActionInspector';

interface PlayheadLifecycleTargetCommandsProps {
  semanticDocument: any;
  semanticItem: any;
  sceneMeta: TimelineScene['meta'];
  semanticAuthoring: any;
  documentStore: ReturnType<typeof useDocumentStore>;
  setSelectedIds: ActionInspectorProps['setSelectedIds'];
}

export const PlayheadLifecycleTargetCommands = React.memo(({
  semanticDocument,
  semanticItem,
  sceneMeta,
  semanticAuthoring,
  documentStore,
  setSelectedIds,
}: PlayheadLifecycleTargetCommandsProps) => {
  const playbackAdapter = usePlaybackAdapter();
  const initialPlayheadTime = Math.round(playbackAdapter.getCurrentTime() * 10) / 10;
  const displayedTimeRef = React.useRef(initialPlayheadTime);
  const [playheadTime, setPlayheadTime] = useState(initialPlayheadTime);

  useEffect(() => playbackAdapter.subscribeTime((time) => {
    const displayedTime = Math.round(time * 10) / 10;
    if (displayedTime === displayedTimeRef.current) return;
    displayedTimeRef.current = displayedTime;
    setPlayheadTime(displayedTime);
  }), [playbackAdapter]);

  const availableBlocks = React.useMemo(() => {
    if (!semanticDocument || !semanticItem || semanticItem.locator.kind !== 'statement') return [];
    const lifecycle = sceneStatementDefinitionRegistry.timelineLifecyclePresentation(semanticItem.source);
    if (!lifecycle || lifecycle.boundary !== 'start') return [];
    const availableIds = listAvailableLifecycleTargetBindingCommandIds(
      semanticDocument,
      playheadTime,
      { sceneMeta },
      new Set([semanticItem.statementId]),
    );
    return SEMANTIC_STATEMENT_BLOCKS.filter((block) => (
      block.stateSpanDependencyCommand?.presentationTypeKey === lifecycle.definition.presentationTypeKey
      && availableIds.has(block.id)
    ));
  }, [playheadTime, sceneMeta, semanticDocument, semanticItem]);

  const addDependency = async (block: SemanticStatementBlockEntry) => {
    if (!semanticAuthoring || !semanticDocument || !semanticItem) return;
    try {
      const command = resolveLifecycleTargetBinding(
        semanticDocument,
        block.id,
        playheadTime,
        { sceneMeta },
        new Set([semanticItem.statementId]),
      );
      if (!command) return;
      const receipt = await semanticAuthoring.author({
        version: AUTHORING_SCHEMA_VERSION,
        correlationId: createSemanticTimelineCorrelationId('inspector_lifecycle_target'),
        origin: 'timeline-editor',
        kind: 'insert-statement',
        anchorTime: playheadTime,
        ...(command.beforeStatementId ? { beforeStatementId: command.beforeStatementId } : {}),
        statement: command.statement,
      });
      const nextSelected = selectCompiledActionsForStatements(
        documentStore.getCompiledSceneSnapshot(),
        receipt.createdStatementIds,
      );
      if (Object.keys(nextSelected).length > 0) setSelectedIds(nextSelected);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法添加状态变化', 'warning');
    }
  };

  if (availableBlocks.length === 0) return null;
  return (
    <div className="inspector-section" data-testid="lifecycle-target-commands">
      <div className="inspector-section-title">在播放头添加变化 · {playheadTime.toFixed(1)}s</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {availableBlocks.map((block) => (
          <button key={block.id} type="button" className="btn btn--sm" onClick={() => { void addDependency(block); }}>
            <IconPlus width={13} height={13} />
            添加{block.label}
          </button>
        ))}
      </div>
    </div>
  );
});
