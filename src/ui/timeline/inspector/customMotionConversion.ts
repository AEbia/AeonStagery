// Resource-motion -> custom-motion conversion dialog open/confirm flow.
// Pure move of the two closures from the ActionInspector body.
import { showToast } from '../../Toast';
import { describeCustomMotionAuthoringError } from '../CustomMotionAuthoring';
import type { CustomMotionDensity } from '../../../engine/live2d/customMotionConversion';
import type { CharacterMotionOutput } from '../../../api/types/semantic-scene';
import type { TimelineAction } from '../semanticTimelineTypes';
import { resolveCubism2MotionMeta } from '../../../engine/live2d/cubism2MotionSampler';
import type { useCustomMotionAuthoring } from './useCustomMotionAuthoring';

type CustomMotionAuthoringState = ReturnType<typeof useCustomMotionAuthoring>;

export interface CustomMotionConversionDeps {
  action: TimelineAction;
  actionId: string;
  actionParams: Record<string, any>;
  editorStore: { setCustomMotionEditorActionId: (id: string | null) => void };
  customMotionAuthoring: CustomMotionAuthoringState['customMotionAuthoring'];
  customMotionLocator: CustomMotionAuthoringState['customMotionLocator'];
  conversionDialog: CustomMotionAuthoringState['conversionDialog'];
  setConversionDialog: CustomMotionAuthoringState['setConversionDialog'];
  setIsConverting: CustomMotionAuthoringState['setIsConverting'];
  characterAdapter?: any;
}

export function createCustomMotionConversion(deps: CustomMotionConversionDeps) {
  const {
    action, actionId, actionParams, editorStore,
    customMotionAuthoring, customMotionLocator, conversionDialog, setConversionDialog, setIsConverting,
    characterAdapter,
  } = deps;

  const openConversionDialog = () => {
    const charId = typeof actionParams.target === 'string' ? actionParams.target : '';
    const motionValue = typeof actionParams.motion === 'object' && actionParams.motion !== null
      ? actionParams.motion as CharacterMotionOutput
      : null;
    const motionKey = motionValue?.kind === 'resource'
      ? motionValue.key
      : motionValue?.kind === 'custom'
        ? motionValue.derivedFrom.key
        : '';
    if (!motionKey) { showToast('当前动作没有可重新采样的源动作', 'warning'); return; }

    const isCustom = motionValue?.kind === 'custom';
    const customDuration = isCustom ? motionValue.durationSeconds : undefined;
    const adapterDuration = (!isCustom && charId && characterAdapter?.getMotionDuration)
      ? characterAdapter.getMotionDuration(charId, motionKey)
      : 0;
    const initialDuration = customDuration
      ?? (adapterDuration > 0
        ? adapterDuration
        : (typeof actionParams.durationSeconds === 'number'
          ? actionParams.durationSeconds
          : (action.params.duration ?? 1)));

    setConversionDialog({
      mode: isCustom ? 'regenerate' : 'convert',
      targetId: charId,
      motionKey,
      durationSeconds: initialDuration,
    });

    if (!isCustom && charId && motionKey && characterAdapter) {
      const targets = characterAdapter.getCubism2SamplerTargets?.(charId) ?? [];
      if (targets.length > 0) {
        void resolveCubism2MotionMeta(targets[0], motionKey).then((meta) => {
          if (meta.durationSeconds > 0) {
            setConversionDialog((prev) => (
              prev && prev.motionKey === motionKey && prev.targetId === charId
                ? { ...prev, durationSeconds: meta.durationSeconds }
                : prev
            ));
          }
        }).catch(() => {});
      }
    }
  };

  const handleConvertConfirm = async (density: CustomMotionDensity) => {
    if (!customMotionAuthoring || !customMotionLocator || !conversionDialog) return;
    setIsConverting(true);
    try {
      const receipt = await customMotionAuthoring.convert(customMotionLocator, density);
      showToast(
        conversionDialog.mode === 'regenerate'
          ? `已从源动作重新生成（${receipt.motion.tracks.length} 条轨道）`
          : `已转为自定义动作（${receipt.motion.tracks.length} 条轨道）`,
        'success',
      );
      setConversionDialog(null);
      editorStore.setCustomMotionEditorActionId(actionId);
    } catch (error) {
      showToast(describeCustomMotionAuthoringError(error), 'error');
    } finally {
      setIsConverting(false);
    }
  };

  return { openConversionDialog, handleConvertConfirm };
}
