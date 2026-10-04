import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cubism2PixiLive2DModelControls } from '../engine/Live2DRuntimeAdapter';

/**
 * Regression tests for the expression-load vs model-teardown race.
 *
 * Sequence under test (observed on project open, first cold-scan bake):
 *   1. BakeEngine fires `setExpression` -> the SDK's async expression pipeline
 *      starts an XHR for the .exp.json.
 *   2. The model is destroyed/replaced while the XHR is in flight. The SDK
 *      destroys the ExpressionManager (`expressions` caches become undefined)
 *      and aborts the XHR, which the SDK logs as "Failed to load expression".
 *   3. The aborted load rejects/continues inside the SDK; without guards the
 *      app let that rejection escape as an uncaught in-promise TypeError
 *      ("Cannot set properties of undefined (setting '<index>')") and kept
 *      touching the destroyed manager.
 *
 * The adapter must: never reach a destroyed manager, and never let the SDK's
 * rejection become an unhandled rejection.
 */

function makeFakeExpressionManager(overrides: Record<string, unknown> = {}) {
  const expMgr: any = {
    destroyed: false,
    expressions: [],
    definitions: [],
    currentExpression: null,
    reserveExpressionIndex: -1,
    defaultExpression: null,
    queueManager: { stopAllMotions: vi.fn() },
    _motionQueueManager: { stopAllMotions: vi.fn() },
    getExpressionIndex: vi.fn(() => 0),
    loadExpression: vi.fn(async () => ({})),
    restoreExpression: vi.fn(),
    ...overrides,
  };
  return expMgr;
}

function makeFakeModel(expMgr: any) {
  return {
    destroyed: false,
    expression: vi.fn(() => Promise.resolve(true)),
    internalModel: {
      coreModel: {},
      motionManager: { expressionManager: expMgr },
    },
  } as any;
}

describe('Cubism2 expression teardown race', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setExpression never touches a destroyed expression manager (name and reset paths)', () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const expMgr = makeFakeExpressionManager({ destroyed: true });
    const model = makeFakeModel(expMgr);

    expect(() => controls.setExpression(model, 'anon/thinking02')).not.toThrow();
    expect(() => controls.setExpression(model, null)).not.toThrow();
    expect(model.expression).not.toHaveBeenCalled();
    expect(expMgr.restoreExpression).not.toHaveBeenCalled();
  });

  it('swallows the SDK rejection when the model dies during an async expression load', async () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const expMgr = makeFakeExpressionManager();
      const model = makeFakeModel(expMgr);
      // The exact failure the SDK produces after destroy() nulls its caches:
      model.expression = vi.fn(() => {
        return Promise.reject(new TypeError("Cannot set properties of undefined (setting '25')"));
      });

      controls.setExpression(model, 'anon/thinking02');

      expect(model.expression).toHaveBeenCalledWith('anon/thinking02');
      // Let the rejection propagate through the microtask queue; it must have
      // been caught by the adapter rather than surfacing as unhandled.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps the sync restoreExpression fast path when the expression is already current', () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const current = { name: 'anon/thinking02' };
    const expMgr = makeFakeExpressionManager({
      expressions: [current],
      currentExpression: current,
      getExpressionIndex: vi.fn(() => 0),
    });
    const model = makeFakeModel(expMgr);

    controls.setExpression(model, 'anon/thinking02');

    expect(expMgr.restoreExpression).toHaveBeenCalled();
    expect(model.expression).not.toHaveBeenCalled();
  });

  it('setExpressionForSeek survives an aborted expression load', async () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const loadExpression = vi.fn(async () => {
      throw new TypeError("Cannot set properties of undefined (setting '25')");
    });
    const expMgr = makeFakeExpressionManager({ loadExpression });
    const model = makeFakeModel(expMgr);

    await expect(controls.setExpressionForSeek(model, 'anon/thinking02', 0.5)).resolves.toBeUndefined();
    expect(loadExpression).toHaveBeenCalledWith(0);
  });

  it('setExpressionForSeek stops touching the manager when it is destroyed while the load is in flight', async () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const expMgr = makeFakeExpressionManager({
      loadExpression: vi.fn(async () => {
        // destroy() lands while the fetch resolves
        expMgr.destroyed = true;
        return { name: 'anon/thinking02' };
      }),
    });
    const model = makeFakeModel(expMgr);

    await expect(controls.setExpressionForSeek(model, 'anon/thinking02', 0.5)).resolves.toBeUndefined();
    expect(expMgr.currentExpression).toBeNull();
    expect(expMgr._setExpression).toBeUndefined();
  });

  it('setExpressionForSeek skips a manager that was already destroyed before the call', async () => {
    const controls = new Cubism2PixiLive2DModelControls();
    const loadExpression = vi.fn(async () => ({}));
    const expMgr = makeFakeExpressionManager({ destroyed: true, loadExpression });
    const model = makeFakeModel(expMgr);

    await expect(controls.setExpressionForSeek(model, 'anon/thinking02', 0.5)).resolves.toBeUndefined();
    expect(loadExpression).not.toHaveBeenCalled();
  });
});