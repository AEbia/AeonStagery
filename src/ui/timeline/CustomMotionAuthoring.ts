import type { AuthoringOrigin } from '../../api/types/authoring';
import type { CharacterMotionOutput } from '../../api/types/semantic-scene';
import { CustomMotionConversionCommand } from '../../services/timeline-authoring/CustomMotionConversionCommand';
import type {
  CustomMotionConversionTarget,
} from '../../services/timeline-authoring/CustomMotionConversionCommand';
import { CustomMotionKeyframeEditCommand } from '../../services/timeline-authoring/CustomMotionKeyframeEditCommand';
import type {
  CustomMotionKeyframeEditTarget,
} from '../../services/timeline-authoring/CustomMotionKeyframeEditCommand';
import type { CustomMotionEditLeaseGate } from '../../services/timeline-authoring/CustomMotionEditLeaseGate';
import type { CustomMotionDensity } from '../../engine/live2d/customMotionConversion';
import type { CustomMotionKeyframeEdit } from '../../services/timeline-authoring/customMotionKeyframeEdits';
import type { SemanticAuthoringApplicationService } from '../../services/timeline-authoring/SemanticAuthoringApplicationService';

export interface CustomMotionAuthoringPorts {
  authoring: SemanticAuthoringApplicationService;
  samplerTargets: (characterId: string) => readonly import('../../engine/live2d/cubism2MotionSampler').Cubism2MotionSamplerTarget[];
  leaseGate?: CustomMotionEditLeaseGate;
  origin?: AuthoringOrigin;
}

export type CustomMotionEditLocator = CustomMotionKeyframeEditTarget;
export type CustomMotionConvertLocator = CustomMotionConversionTarget;

export interface CustomMotionConversionUiReceipt {
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  staticTrackIds: readonly string[];
  simplifiedTrackIds: readonly string[];
}

/**
 * Thin UI facade over the ADR-0029 authoring commands. All writes go through
 * the atomic authoring pipeline (sampling → fit → lease → commit); the UI only
 * builds edit batches and renders results.
 */
export class CustomMotionAuthoring {
  private readonly keyframeCommand: CustomMotionKeyframeEditCommand;
  private readonly conversionCommand: CustomMotionConversionCommand;
  private readonly origin: AuthoringOrigin;

  constructor(ports: CustomMotionAuthoringPorts) {
    this.origin = ports.origin ?? 'timeline-editor';
    this.keyframeCommand = new CustomMotionKeyframeEditCommand({
      authoring: ports.authoring,
      ...(ports.leaseGate ? { leaseGate: ports.leaseGate } : {}),
    });
    this.conversionCommand = new CustomMotionConversionCommand({
      authoring: ports.authoring,
      samplerTargets: (characterId) => ports.samplerTargets(characterId),
      ...(ports.leaseGate ? { leaseGate: ports.leaseGate } : {}),
    });
  }

  async commitEdits(
    locator: CustomMotionEditLocator,
    edits: readonly CustomMotionKeyframeEdit[],
    correlationId?: string,
    expectedMotion?: Extract<CharacterMotionOutput, { kind: 'custom' }>,
    expectedSceneId?: string,
    expectedFps?: number,
  ): Promise<void> {
    await this.keyframeCommand.edit({
      locator,
      edits,
      ...(expectedMotion ? { expectedMotion } : {}),
      ...(expectedSceneId !== undefined ? { expectedSceneId } : {}),
      ...(expectedFps !== undefined ? { expectedFps } : {}),
      origin: this.origin,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  async convert(
    locator: CustomMotionConvertLocator,
    density: CustomMotionDensity,
    correlationId?: string,
  ): Promise<CustomMotionConversionUiReceipt> {
    const receipt = await this.conversionCommand.convert({
      locator,
      density,
      origin: this.origin,
      ...(correlationId ? { correlationId } : {}),
    });
    return {
      motion: receipt.motion,
      staticTrackIds: receipt.staticTrackIds,
      simplifiedTrackIds: receipt.simplifiedTrackIds,
    };
  }
}

/** Map a command error code to a friendly Chinese message. */
export function describeCustomMotionAuthoringError(error: unknown): string {
  const candidate = error as { code?: string; message?: string };
  const code = candidate?.code;
  const fallback = candidate?.message ? String(candidate.message) : '操作失败，请稍后再试';
  switch (code) {
    case 'lease-denied': return '编辑租约被协作者占用，无法修改。请等待对方释放后再试。';
    case 'character-not-loaded': return '角色尚未加载为 Cubism 2.1 模型，无法采样转换。请先在舞台上加载角色。';
    case 'no-convertible-parameters': return '源动作没有可转换的参数曲线（仅剩 Parts 曲线）。';
    case 'motion-source-unavailable': return '当前动作没有可重新采样的源动作，无法转换。';
    case 'sampling-failed': return '采样失败：源动作无法在该模型上解析。';
    case 'entity-changed': return '采样期间源动作被其他协作者修改，转换已中止，请重试。';
    case 'motion-not-custom': return '该动作不是自定义动作，无法进行关键帧编辑。';
    case 'f0-protected': return 'F0 起点必须保留，不能删除。';
    case 'keyframe-time-collision': return '该时刻已有关键帧，请换一个时间。';
    case 'duration-below-fade': return '时长不能短于淡入时长。';
    default: return fallback;
  }
}
