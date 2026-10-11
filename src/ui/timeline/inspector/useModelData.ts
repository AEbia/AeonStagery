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

  return { targetModelPath, ...useCharacterModelData(characterAdapter, targetModelPath) };
}

const EMPTY_MODEL_DATA = { motions: [] as string[], expressions: [] as string[] };

export function useCharacterModelData(
  characterAdapter: ReturnType<typeof useCharacterAdapter>,
  targetModelPath: string | undefined,
) {
  const [loaded, setLoaded] = useState<{ path: string; data: typeof EMPTY_MODEL_DATA } | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!targetModelPath) {
      return;
    }

    void characterAdapter.getModelDataFromPath(targetModelPath)
      .then((data) => {
        if (cancelled) return;
        setLoaded({ path: targetModelPath, data });
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded({ path: targetModelPath, data: EMPTY_MODEL_DATA });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [characterAdapter, targetModelPath]);

  return {
    modelData: loaded && loaded.path === targetModelPath ? loaded.data : EMPTY_MODEL_DATA,
    isModelDataLoading: Boolean(targetModelPath && loaded?.path !== targetModelPath),
  };
}
