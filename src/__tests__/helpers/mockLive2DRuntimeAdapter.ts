import { createLive2DModelHandle } from '../../engine/live2d/runtime/Live2DRuntimeControlModule';
import { vi } from 'vitest';
import type {
  Live2DRuntimeAdapter,
  Live2DSeekRestoreResult,
} from '../../engine/Live2DRuntimeAdapter';
import type { Live2DRuntimeControlPort } from '../../engine/runtime/Live2DRuntimeControlPort';
import type { Live2DModelDisplayObject } from '../../engine/runtime/Live2DRuntimeContracts';

/**
 * Shared runtime-controls mock for engine tests.
 *
 * The engine seam (BakeEngine / Live2DManager / Live2DMotionController) calls
 * the full controls surface, so every adapter mock must provide all methods.
 * Tests override the behaviours they actually assert on; everything else
 * defaults to benign no-ops.
 */
export function mockControls(overrides: Partial<Live2DRuntimeControlPort> = {}): Live2DRuntimeControlPort {
  return {
    getCoreModel: vi.fn(() => null),
    describeInvalidState: vi.fn(() => null),
    getAvailableMotions: vi.fn(() => []),
    getAvailableExpressions: vi.fn(() => []),
    getMotionDuration: vi.fn(() => 0),
    getMotionDebugState: vi.fn(() => null),
    getParameterValues: vi.fn(() => null),
    getParameterMetadata: vi.fn(() => null),
    registerExternalMotion: vi.fn(async () => ({
      status: 'compatible' as const, missingParameterIds: [], ignoredParameterIds: [], diagnostics: [],
    })),
    registerExternalExpression: vi.fn(async () => ({
      status: 'compatible' as const, missingParameterIds: [], ignoredParameterIds: [], diagnostics: [],
    })),
    unregisterExternalPerformance: vi.fn(),
    clearMotionState: vi.fn(),
    stopAllMotions: vi.fn(),
    preloadMotion: vi.fn(async () => {}),
    setExpression: vi.fn(),
    setExpressionForSeek: vi.fn(async () => {}),
    setInjectedParameter: vi.fn(),
    syncInputParameters: vi.fn(),
    captureSnapshot: vi.fn(() => null),
    applySnapshot: vi.fn(),
    restoreSeekState: vi.fn(async () => ({ status: 'restored', tierUsed: 'native' }) as Live2DSeekRestoreResult),
    renderForBake: vi.fn(),
    getConcreteModels: vi.fn((model: any) => (model ? [model] : [])),
    advanceFrame: vi.fn(),
    advanceMotionOnly: vi.fn(),
    stepBakeFrame: vi.fn(),
    flushIdleState: vi.fn(async () => {}),
    resetModelToIdle: vi.fn(async () => {}),
    applyIdleBaseline: vi.fn(),
    captureIdleSnapshot: vi.fn(() => null),
    restartIdleMotion: vi.fn(async () => {}),
    hasMotionGroup: vi.fn(() => true),
    startMotion: vi.fn(async () => ({ ok: true, offsetReplayMs: 0 })),
    sampleMotion: vi.fn(async () => ({ status: 'unsupported' as const })),
    installCustomMotionStage: vi.fn(() => null),
    quiesceModel: vi.fn(),
    disposeModel: vi.fn(),
    prepareModel: vi.fn(),
    prepareModelResources: vi.fn(),
    isolateMask: vi.fn(),
    installBakeRenderGuards: vi.fn(),
    setBlink: vi.fn(),
    applyFocus: vi.fn(),
    getFocusControllers: vi.fn(() => []),
    manageFocusAnimations: vi.fn(),
    getHeadAnchor: vi.fn(() => null),
    ...overrides,
  };
}

/** Shared adapter mock with benign defaults (override per test). */
type MockAdapterOverrides = Partial<Live2DRuntimeAdapter> & {
  /** Test-only control injection; the mock adapter never exposes this port. */
  createTestControls?: () => Live2DRuntimeControlPort;
};

export function mockAdapter(overrides: MockAdapterOverrides = {}): Live2DRuntimeAdapter {
  const { createTestControls, ...adapterOverrides } = overrides;
  return {
    id: 'pixi-live2d-display-cubism2',
    supported: true,
    init: vi.fn(async () => {}),
    isReady: vi.fn(() => true),
    createModelHandle: vi.fn((id, model, runtime) => createLive2DModelHandle({
      id, model, runtime: runtime ?? { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
      controls: createTestControls?.() ?? mockControls(),
    })),
    createModel: vi.fn(async () => ({} as Live2DModelDisplayObject)),
    getUnsupportedMessage: vi.fn(() => null),
    createFallbackModel: vi.fn(() => null),
    disposeBakeRenderTexture: vi.fn(),
    ...adapterOverrides,
  };
}
