// Model-data (motions/expressions) loading for the inspector's active character model path.
import React, { useEffect, useState } from 'react';
import { resolveCharacterPerformanceTargetCharId } from '../characterPerformancePresentation';
import { resolveActiveModelPath } from './entranceModelOptions';
import type { TimelineAction, TimelineScene } from '../semanticTimelineTypes';
import type { useCharacterAdapter } from '../../context/AppContext';

export function useModelData(args: {
  characterAdapter: ReturnType<typeof useCharacterAdapter>;
  sceneData: TimelineScene;
  selectedIdsList: string[];
  action: TimelineAction | undefined;
  performanceTargetSpeakerId: string | undefined;
  timelineActions: TimelineAction[];
}) {
  const { characterAdapter, sceneData, selectedIdsList, action, performanceTargetSpeakerId, timelineActions } = args;

  const [modelData, setModelData] = useState<{ motions: string[], expressions: string[] }>({ motions: [], expressions: [] });
  const [isModelDataLoading, setIsModelDataLoading] = useState(false);

  const targetModelPath = React.useMemo(() => {
    if (selectedIdsList.length !== 1 || !action) return undefined;
    const charId = action.params.id || action.params.speakerId || action.params.targetCharacter
      || (action.semanticType === 'characterPerformance'
        ? resolveCharacterPerformanceTargetCharId(action, performanceTargetSpeakerId)
        : undefined);
    return charId
      ? resolveActiveModelPath(sceneData, timelineActions, charId, action.time || 0)
      : undefined;
  }, [action, performanceTargetSpeakerId, sceneData, selectedIdsList.length, timelineActions]);

  useEffect(() => {
    let cancelled = false;

    if (!targetModelPath) {
      setModelData({ motions: [], expressions: [] });
      setIsModelDataLoading(false);
      return;
    }

    setIsModelDataLoading(true);
    void characterAdapter.getModelDataFromPath(targetModelPath)
      .then((data: any) => {
        if (cancelled) return;
        setModelData(data);
        setIsModelDataLoading(false);
      })
      .catch(() => {
        if (!cancelled) setIsModelDataLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [characterAdapter, targetModelPath]);

  return { targetModelPath, modelData, isModelDataLoading };
}
