// Selection derivation for the Action Inspector: resolve the single selected display
// action and its semantic read-model item (ADR-0022 placeholders included).
import React from 'react';
import { isCharacterPerformancePlaceholderParams } from '../../../services/semantic-scene';
import type { SemanticTimelineReadModelItem } from '../semanticTimelineReadModel';

export function useActionSelection(args: {
  selectedActionIds: Record<string, boolean>;
  items: SemanticTimelineReadModelItem[];
}) {
  const { selectedActionIds, items: semanticTimelineItems } = args;

  const selectedIdsList = Object.keys(selectedActionIds);
  const selectedActionId = selectedIdsList[0];
  // Ordinary statement display actions only — no synthetic StateSpan projection.
  const timelineActions = React.useMemo(
    () => semanticTimelineItems.map((item) => item.displayAction),
    [semanticTimelineItems],
  );
  const action = React.useMemo(
    () => timelineActions.find((candidate) => candidate._id === selectedActionId),
    [selectedActionId, timelineActions],
  );
  const actionId = action?._id ?? selectedActionId;
  const semanticItem = semanticTimelineItems.find((item) => item.displayAction._id === actionId);
  // ADR-0022 placeholder: raw characterPerformance block with exact empty
  // motion. Its $speaker target resolves to the parent dialogue speaker so
  // the motion/expression pickers load the right model data and previews.
  const placeholderSourceParams = action?.sourceParams;
  const isPlaceholderPerformance = action?.action === 'characterPerformance'
    && !!placeholderSourceParams
    && isCharacterPerformancePlaceholderParams(placeholderSourceParams as { motion?: unknown });
  const placeholderSpeakerCharacterId = isPlaceholderPerformance
    ? action.resolvedSpeakerId
      ?? (semanticItem?.locator.kind === 'companion'
        ? (semanticTimelineItems.find((item) => (
          item.statementId === semanticItem.locator.statementId
          && !item.companionId
          && item.source.type === 'dialogue'
        ))?.source.params as { speakerId?: string } | undefined)?.speakerId
        : undefined)
    : undefined;
  // The performance target's backing speaker id: the read model resolves the
  // literal $speaker token to the parent dialogue speaker for every
  // characterPerformance companion (placeholder or already filled by the
  // acting stage). Surfaces that read the raw target (binding select, model
  // pickers) use this so the auto-bound character is always visible.
  const performanceTargetSpeakerId = action?.semanticType === 'characterPerformance'
    ? action?.resolvedSpeakerId ?? placeholderSpeakerCharacterId
    : undefined;

  return {
    selectedIdsList,
    selectedActionId,
    semanticTimelineItems,
    timelineActions,
    action,
    actionId,
    semanticItem,
    isPlaceholderPerformance,
    placeholderSpeakerCharacterId,
    performanceTargetSpeakerId,
  };
}
