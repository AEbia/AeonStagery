// Custom-motion authoring service + conversion-dialog state for the inspector
// (ADR-0029 keyframe authoring, ADR-0028 edit lease).
import React, { useEffect, useState } from 'react';
import { useApp, useCharacterAdapter } from '../../context/AppContext';
import { CustomMotionAuthoring } from '../CustomMotionAuthoring';
import { estimateCustomMotionKeyframes, type CustomMotionDensity } from '../../../engine/live2d/customMotionConversion';
import { resolveCubism2MotionMeta } from '../../../engine/live2d/cubism2MotionSampler';
import type { CustomMotionConversionDialogState } from '../CustomMotionConversionDialog';
import type { SemanticTimelineReadModelItem } from '../semanticTimelineReadModel';

export function useCustomMotionAuthoring(args: {
  semanticItem: SemanticTimelineReadModelItem | undefined;
  fps?: number;
}) {
  const { semanticItem, fps = 60 } = args;
  const appContext = useApp();
  const characterAdapter = useCharacterAdapter();
  const semanticAuthoring = appContext.services?.semanticAuthoring;
  const customMotionEditLeaseGate = appContext.collaboration?.customMotionEditLeaseGate ?? undefined;

  const customMotionAuthoring = React.useMemo(() => {
    if (!semanticAuthoring) return null;
    return new CustomMotionAuthoring({
      authoring: semanticAuthoring,
      samplerTargets: (characterId) => characterAdapter.getCubism2SamplerTargets?.(characterId) ?? [],
      leaseGate: customMotionEditLeaseGate,
      origin: 'timeline-editor',
    });
  }, [semanticAuthoring, characterAdapter, customMotionEditLeaseGate]);

  const [conversionDialog, setConversionDialog] = useState<CustomMotionConversionDialogState | null>(null);
  const [isConverting, setIsConverting] = useState(false);

  const conversionTargetId = conversionDialog?.targetId;
  const conversionMotionKey = conversionDialog?.motionKey;
  const conversionMode = conversionDialog?.mode;

  useEffect(() => {
    if (conversionMode !== 'convert' || !conversionTargetId || !conversionMotionKey) return;
    const targets = characterAdapter.getCubism2SamplerTargets?.(conversionTargetId) ?? [];
    if (targets.length === 0) return;
    let active = true;
    void resolveCubism2MotionMeta(targets[0], conversionMotionKey).then((meta) => {
      if (!active) return;
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

  const customMotionLocator = React.useMemo(() => {
    if (!semanticItem) return null;
    if (semanticItem.locator.kind === 'companion') {
      return { kind: 'companion' as const, statementId: semanticItem.statementId, companionId: semanticItem.companionId! };
    }
    return { kind: 'statement' as const, statementId: semanticItem.statementId };
  }, [semanticItem]);

  const estimateKeyframesForDensity = React.useCallback((density: CustomMotionDensity): number => {
    if (!conversionDialog) return 0;
    return estimateCustomMotionKeyframes(conversionDialog.durationSeconds, density, fps);
  }, [conversionDialog, fps]);

  return {
    customMotionAuthoring,
    customMotionLocator,
    conversionDialog,
    setConversionDialog,
    isConverting,
    setIsConverting,
    estimateKeyframesForDensity,
  };
}
