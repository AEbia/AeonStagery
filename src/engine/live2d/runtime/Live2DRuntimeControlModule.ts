import type * as PIXI from 'pixi.js';
import type { Live2DParameterMetadata } from '../../../api/types/live2d-parameter-animation';
import type { ModelSnapshot } from '../../Live2DConfig';
import type { Live2DAdapterId, Live2DRuntimeDescriptor } from '../../Live2DRuntimeResolver';
import type {
  Live2DDeterminismCapabilities,
  Live2DRuntimeModelControls,
  Live2DSeekRestoreInput,
  Live2DSeekRestoreResult,
} from '../../runtime/Live2DRuntimeContracts';

export interface Live2DRuntimeCapabilities {
  readonly runtimeFamily: Live2DRuntimeDescriptor['runtimeFamily'];
  readonly adapterId: Live2DAdapterId;
  readonly supportsMotion: boolean;
  readonly supportsExpression: boolean;
  readonly supportsParameterInjection: boolean;
  readonly supportsSnapshot: boolean;
  readonly supportsBakeRender: boolean;
  readonly usesCubism2PrivateControls: boolean;
  readonly determinism: Live2DDeterminismCapabilities;
}

function resolveDeterminismCapabilities(adapterId: Live2DAdapterId): Live2DDeterminismCapabilities {
  if (adapterId === 'pixi-live2d-display-cubism2') {
    return {
      tier: 'native-offset-deterministic',
      supportsParameterCurves: true,
      supportsNativeMotionOffset: true,
      supportsStateReplay: false,
      diagnostics: [
        'Cubism 2 native motion offsets use fixed-step SDK clock replay.',
        'Stateful Physics/Pose replay is not guaranteed by this adapter.',
      ],
    };
  }
  if (adapterId === 'untitled-pixi-live2d-engine-cubism') {
    return {
      tier: 'state-replay-deterministic',
      supportsParameterCurves: true,
      supportsNativeMotionOffset: true,
      supportsStateReplay: true,
      diagnostics: [
        'Cubism 3+ parameter motions use the runtime-neutral deterministic curve cache when available.',
        'Physics/Pose/LookAt state is reset and reconstructed with fixed 60Hz steps during seek replay.',
      ],
    };
  }
  return {
    tier: 'unsupported',
    supportsParameterCurves: false,
    supportsNativeMotionOffset: false,
    supportsStateReplay: false,
    diagnostics: ['No runtime adapter can provide deterministic motion evaluation.'],
  };
}

export interface Live2DLifecycleInterface {
  getCoreModel(): any | null;
  clearMotionState(): void;
  stopAllMotions(): void;
}

export interface Live2DMotionInterface {
  getAvailableMotions(): string[];
  getMotionDuration(motionKey: string): number;
  getMotionDebugState(): Record<string, unknown> | null;
  preloadMotion(motionKey: string): Promise<void>;
}

export interface Live2DExpressionInterface {
  getAvailableExpressions(): string[];
  setExpression(expressionName: string | null): void;
}

export interface Live2DParameterInterface {
  getParameterValues(): Array<{ index: number; name: string; value: number }> | null;
  getParameterMetadata(): readonly Live2DParameterMetadata[] | null;
  setInjectedParameter(paramName: string, value: number): void;
  syncInputParameters(): void;
}

export interface Live2DSnapshotInterface {
  captureSnapshot(motionStartTime?: number): ModelSnapshot | null;
  applySnapshot(snapshot: ModelSnapshot): void;
  restoreSeekState(input: Live2DSeekRestoreInput): Promise<Live2DSeekRestoreResult>;
}

export interface Live2DRenderInterface {
  renderForBake(renderer: any, label?: string, renderTexture?: any): void;
}

export interface Live2DDiagnosticsInterface {
  describeInvalidState(): string | null;
}

export interface Live2DModelHandle {
  readonly id: string;
  readonly runtime: Live2DRuntimeDescriptor;
  readonly displayObject: PIXI.Container;
  readonly rawModel: any;
  readonly capabilities: Live2DRuntimeCapabilities;
  readonly lifecycle: Live2DLifecycleInterface;
  readonly motion: Live2DMotionInterface;
  readonly expression: Live2DExpressionInterface;
  readonly parameters: Live2DParameterInterface;
  readonly snapshot: Live2DSnapshotInterface;
  readonly render: Live2DRenderInterface;
  readonly diagnostics: Live2DDiagnosticsInterface;
}

export interface Live2DModelHandleCreateOptions {
  id: string;
  model: any;
  runtime: Live2DRuntimeDescriptor;
  controls: Live2DRuntimeModelControls;
}

export function createLive2DModelHandle({
  id,
  model,
  runtime,
  controls,
}: Live2DModelHandleCreateOptions): Live2DModelHandle {
  const capabilities: Live2DRuntimeCapabilities = {
    runtimeFamily: runtime.runtimeFamily,
    adapterId: runtime.adapterId,
    supportsMotion: runtime.adapterId !== 'unknown',
    supportsExpression: runtime.adapterId !== 'unknown',
    supportsParameterInjection: runtime.adapterId !== 'unknown',
    supportsSnapshot: runtime.adapterId !== 'unknown',
    supportsBakeRender: runtime.adapterId !== 'unknown',
    usesCubism2PrivateControls: runtime.adapterId === 'pixi-live2d-display-cubism2',
    determinism: resolveDeterminismCapabilities(runtime.adapterId),
  };

  return {
    id,
    runtime,
    displayObject: model as PIXI.Container,
    rawModel: model,
    capabilities,
    lifecycle: {
      getCoreModel: () => controls.getCoreModel(model),
      clearMotionState: () => controls.clearMotionState(model),
      stopAllMotions: () => controls.stopAllMotions(model),
    },
    motion: {
      getAvailableMotions: () => controls.getAvailableMotions(model),
      getMotionDuration: (motionKey) => controls.getMotionDuration(model, motionKey),
      getMotionDebugState: () => controls.getMotionDebugState(model),
      preloadMotion: (motionKey) => controls.preloadMotion(model, motionKey),
    },
    expression: {
      getAvailableExpressions: () => controls.getAvailableExpressions(model),
      setExpression: (expressionName) => controls.setExpression(model, expressionName),
    },
    parameters: {
      getParameterValues: () => controls.getParameterValues(model),
      getParameterMetadata: () => controls.getParameterMetadata(model),
      setInjectedParameter: (paramName, value) => controls.setInjectedParameter(model, paramName, value),
      syncInputParameters: () => controls.syncInputParameters(model),
    },
    snapshot: {
      captureSnapshot: (motionStartTime) => controls.captureSnapshot(id, model, motionStartTime),
      applySnapshot: (snapshot) => controls.applySnapshot(model, snapshot),
      restoreSeekState: (input) => controls.restoreSeekState(model, input),
    },
    render: {
      renderForBake: (renderer, label, renderTexture) => controls.renderForBake(model, renderer, label, renderTexture),
    },
    diagnostics: {
      describeInvalidState: () => controls.describeInvalidState(model),
    },
  };
}
