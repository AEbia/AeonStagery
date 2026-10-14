// Application conversion service and read-only conversion-dialog state.
import React, { useEffect, useState } from 'react';
import { useApp, useCharacterAdapter } from '../../context/AppContext';
import type { CustomMotionEditTarget } from '../../../services/timeline-authoring/CustomMotionEditingTypes';
import { estimateCustomMotionKeyframes, type CustomMotionDensity } from '../../../engine/live2d/customMotionConversion';
import type { CustomMotionConversionDialogState } from '../CustomMotionConversionDialog';
import type { SemanticTimelineReadModelItem } from '../semanticTimelineReadModel';

export function useCustomMotionAuthoring(args: {
  semanticItem: SemanticTimelineReadModelItem | undefined;
  fps?: number;
}) {
  const { semanticItem, fps = 60 } = args;
  const appContext = useApp();
  const characterAdapter = useCharacterAdapter();
  const customMotionConversion = appContext.services?.customMotionConversion;

  const [conversionDialog, setConversionDialog] = useState<CustomMotionConversionDialogState | null>(null);
  const [isConverting, setIsConverting] = useState(false);

  const conversionTargetId = conversionDialog?.targetId;
  const conversionMotionKey = conversionDialog?.motionKey;
  const conversionMode = conversionDialog?.mode;

  useEffect(() => {
    if (conversionMode !== 'convert' || !conversionTargetId || !conversionMotionKey) return;
    if (!characterAdapter.sampleMotion) return;
    let active = true;
    void characterAdapter.sampleMotion(conversionTargetId, conversionMotionKey, { fps, zeroSourceFades: true }).then((sampled) => {
      if (!active) return;
      const meta = sampled.metadata;
      if (!meta) return;
      if (meta.durationSeconds > 0) {
        setConversionDialog((prev) => (
          prev && prev.targetId === conversionTargetId && prev.motionKey === conversionMotionKey && Math.abs(prev.durationSeconds - meta.durationSeconds) > 0.001
            ? { ...prev, durationSeconds: meta.durationSeconds }
            : prev
        ));
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [conversionMode, conversionTargetId, conversionMotionKey, characterAdapter]);

  const customMotionTarget = React.useMemo<CustomMotionEditTarget | null>(() => (
    semanticItem ? {
      statementId: semanticItem.statementId,
      ...(semanticItem.companionId ? { companionId: semanticItem.companionId } : {}),
    } : null
  ), [semanticItem]);

  const estimateKeyframesForDensity = React.useCallback((density: CustomMotionDensity): number => {
    if (!conversionDialog) return 0;
    return estimateCustomMotionKeyframes(conversionDialog.durationSeconds, density, fps);
  }, [conversionDialog, fps]);

  return {
    customMotionConversion,
    customMotionTarget,
    conversionDialog,
    setConversionDialog,
    isConverting,
    setIsConverting,
    estimateKeyframesForDensity,
  };
}
