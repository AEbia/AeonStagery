// Resource-motion -> custom-motion conversion dialog open/confirm flow.
// The application conversion service owns confirmation, authorization, and editor handoff.
import { showToast } from '../../Toast';
import type { CustomMotionDensity } from '../../../engine/live2d/customMotionConversion';
import type { CharacterMotionOutput } from '../../../api/types/semantic-scene';
import type { TimelineAction } from '../semanticTimelineTypes';
import type { useCustomMotionAuthoring } from './useCustomMotionAuthoring';

type CustomMotionConversionState = ReturnType<typeof useCustomMotionAuthoring>;

export interface CustomMotionConversionDeps {
  action: TimelineAction;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inspector controls dispatch heterogeneous semantic parameter schemas by runtime field key; the authoring service validates writes instead of imposing one false common payload.
  actionParams: Record<string, any>;
  customMotionConversion: CustomMotionConversionState['customMotionConversion'];
  customMotionTarget: CustomMotionConversionState['customMotionTarget'];
  conversionDialog: CustomMotionConversionState['conversionDialog'];
  setConversionDialog: CustomMotionConversionState['setConversionDialog'];
  setIsConverting: CustomMotionConversionState['setIsConverting'];
  characterAdapter?: Pick<import('../../../api/interfaces/ICharacterAdapter').ICharacterAdapter, 'getMotionDuration'>;
}

export function createCustomMotionConversion(deps: CustomMotionConversionDeps) {
  const {
    action, actionParams,
    customMotionConversion, customMotionTarget, conversionDialog, setConversionDialog, setIsConverting,
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

  };

  const handleConvertConfirm = async (density: CustomMotionDensity) => {
    if (!customMotionConversion || !customMotionTarget || !conversionDialog) return;
    setIsConverting(true);
    try {
      const receipt = await customMotionConversion.convert(customMotionTarget, density);
      showToast(
        conversionDialog.mode === 'regenerate'
          ? `已从源动作重新生成（${receipt.motion.tracks.length} 条轨道）`
          : `已转为自定义动作（${receipt.motion.tracks.length} 条轨道）`,
        'success',
      );
      setConversionDialog(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '自定义动作转换失败', 'error');
    } finally {
      setIsConverting(false);
    }
  };

  return { openConversionDialog, handleConvertConfirm };
}
