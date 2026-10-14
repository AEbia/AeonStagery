import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cubism2PixiLive2DModelControls } from '../engine/runtime/Cubism2PixiLive2DModelControls';
import { createLive2DModelHandle } from '../engine/live2d/runtime/Live2DRuntimeControlModule';

type Expression = { name: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function createModel() {
  const defaultExpression: Expression = { name: 'default' };
  const queued: Expression[] = [];
  const expressionManager = {
    destroyed: false,
    definitions: [{ name: 'smile' }, { name: 'sad' }],
    expressions: [{ name: 'smile' }, { name: 'sad' }] as Expression[],
    currentExpression: defaultExpression,
    defaultExpression,
    reserveExpressionIndex: -1,
    getExpressionIndex: (name: string) => name === 'smile' ? 0 : name === 'sad' ? 1 : -1,
    loadExpression: vi.fn(async (index: number): Promise<Expression | undefined> => expressionManager.expressions[index]),
    queueManager: { stopAllMotions: vi.fn(() => { queued.length = 0; }) },
    _setExpression: vi.fn((expression: Expression) => { queued.push(expression); }),
    // Vendor reset only queues default; it does not clear reservations or queues.
    resetExpression: () => { expressionManager._setExpression(defaultExpression); },
    stopAllExpressions: () => { expressionManager.queueManager.stopAllMotions(); },
    restoreExpression: () => { expressionManager._setExpression(expressionManager.currentExpression); },
    update: vi.fn(),
  };
  const motionManager = {
    expressionManager,
    stopAllMotions: vi.fn(),
    _motionQueueManager: { stopAllMotions: vi.fn() },
  };
  const model = {
    destroyed: false,
    visible: true,
    renderable: true,
    alpha: 1,
    update: vi.fn(),
    stopAllMotions: vi.fn(),
    internalModel: { coreModel: {}, motionManager },
    // Match the SDK's reservation-based continuation, including same-index reuse.
    expression: async (name: string) => {
      const index = expressionManager.getExpressionIndex(name);
      if (index < 0 || expressionManager.expressions[index] === expressionManager.currentExpression) return false;
      expressionManager.reserveExpressionIndex = index;
      const expression = await expressionManager.loadExpression(index);
      if (!expression || expressionManager.reserveExpressionIndex !== index) return false;
      expressionManager.reserveExpressionIndex = -1;
      expressionManager.currentExpression = expression;
      expressionManager._setExpression(expression);
      return true;
    },
  };
  return { model, expressionManager, queued, defaultExpression };
}

function createHandle(model: object, controls: Cubism2PixiLive2DModelControls) {
  return createLive2DModelHandle({
    id: 'hero', model, controls,
    runtime: { runtimeFamily: 'cubism2', adapterId: 'pixi-live2d-display-cubism2', supported: true },
  });
}

async function settleLoads() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Cubism 2 Expression lifecycle through the bound handle', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('drops a named expression load after the borrowed model is quiesced', async () => {
    const { model, expressionManager, queued, defaultExpression } = createModel();
    const load = deferred<Expression>();
    expressionManager.loadExpression.mockReturnValueOnce(load.promise);
    const handle = createHandle(model, new Cubism2PixiLive2DModelControls({ clock: () => null }));

    handle.expression.setExpression('smile');
    handle.quiesce();
    load.resolve({ name: 'late-smile' });
    await settleLoads();

    expect(queued).toEqual([]);
    expect(expressionManager.currentExpression).toBe(defaultExpression);
    expect(expressionManager.reserveExpressionIndex).toBe(-1);
  });

  it('drops a Seek expression load after the borrowed model is quiesced', async () => {
    const { model, expressionManager, queued, defaultExpression } = createModel();
    const load = deferred<Expression>();
    expressionManager.loadExpression.mockReturnValueOnce(load.promise);
    let timeMs = 10_000;
    const controls = new Cubism2PixiLive2DModelControls({ clock: () => ({
      getUserTimeMSec: () => timeMs,
      setUserTimeMSec: (value) => { timeMs = value; },
    }) });
    const handle = createHandle(model, controls);

    const seek = handle.expression.restoreAtSceneTime('smile', 0.5, null, () => true);
    handle.quiesce();
    load.resolve({ name: 'late-smile' });
    await seek;

    expect(queued).toEqual([]);
    expect(expressionManager.currentExpression).toBe(defaultExpression);
    expect(model.update).not.toHaveBeenCalled();
    expect(timeMs).toBe(10_000);
  });

  it('empties resident expression queues instead of queueing a default during quiesce', () => {
    const { model, expressionManager, queued, defaultExpression } = createModel();
    const smile = expressionManager.expressions[0];
    expressionManager.currentExpression = smile;
    expressionManager.reserveExpressionIndex = 1;
    queued.push(smile);

    createHandle(model, new Cubism2PixiLive2DModelControls()).quiesce();

    expect(queued).toEqual([]);
    expect(expressionManager.currentExpression).toBe(defaultExpression);
    expect(expressionManager.reserveExpressionIndex).toBe(-1);
  });

  it('resets the actual SDK expression manager when restoring idle', async () => {
    const { model, expressionManager, queued, defaultExpression } = createModel();
    const load = deferred<Expression>();
    expressionManager.loadExpression.mockReturnValueOnce(load.promise);
    const controls = new Cubism2PixiLive2DModelControls({ clock: () => null });
    createHandle(model, controls).expression.setExpression('smile');
    queued.push(expressionManager.expressions[1]);

    await controls.resetModelToIdle(model);
    load.resolve({ name: 'late-smile' });
    await settleLoads();

    expect(queued).toEqual([]);
    expect(expressionManager.currentExpression).toBe(defaultExpression);
    expect(expressionManager.reserveExpressionIndex).toBe(-1);
  });

  it('keeps the newest same-name request when the older load completes first', async () => {
    const { model, expressionManager, queued } = createModel();
    const older = deferred<Expression>();
    const newest = deferred<Expression>();
    expressionManager.loadExpression.mockReturnValueOnce(older.promise).mockReturnValueOnce(newest.promise);
    const handle = createHandle(model, new Cubism2PixiLive2DModelControls());

    handle.expression.setExpression('smile');
    handle.expression.setExpression('smile');
    older.resolve({ name: 'obsolete-smile' });
    await settleLoads();
    expect(queued).toEqual([]);

    const newestExpression = { name: 'newest-smile' };
    newest.resolve(newestExpression);
    await settleLoads();
    expect(queued).toEqual([newestExpression]);
    expect(expressionManager.currentExpression).toBe(newestExpression);
  });

  it('does not let a previous borrower consume a new same-name reservation', async () => {
    const { model, expressionManager, queued } = createModel();
    const oldBorrower = deferred<Expression>();
    const newBorrower = deferred<Expression>();
    expressionManager.loadExpression.mockReturnValueOnce(oldBorrower.promise).mockReturnValueOnce(newBorrower.promise);
    const controls = new Cubism2PixiLive2DModelControls();
    const oldHandle = createHandle(model, controls);
    oldHandle.expression.setExpression('smile');
    oldHandle.quiesce();
    const newHandle = createHandle(model, controls);
    newHandle.expression.setExpression('smile');

    oldBorrower.resolve({ name: 'previous-borrower' });
    await settleLoads();
    expect(queued).toEqual([]);
    const currentExpression = { name: 'current-borrower' };
    newBorrower.resolve(currentExpression);
    await settleLoads();
    expect(queued).toEqual([currentExpression]);
  });

  it('invalidates a pending expression when a model is soft-detached directly', async () => {
    const { model, expressionManager, queued } = createModel();
    const load = deferred<Expression>();
    expressionManager.loadExpression.mockReturnValueOnce(load.promise);
    const handle = createHandle(model, new Cubism2PixiLive2DModelControls());
    handle.expression.setExpression('smile');

    handle.dispose({ mode: 'soft-detach' });
    load.resolve({ name: 'late-smile' });
    await settleLoads();

    expect(queued).toEqual([]);
    expect(model.visible).toBe(false);
    expect(model.renderable).toBe(false);
  });

  it('ignores an aborted owned load and permits the next expression request', async () => {
    const { model, expressionManager, queued } = createModel();
    const aborted = deferred<Expression>();
    expressionManager.loadExpression.mockReturnValueOnce(aborted.promise);
    const handle = createHandle(model, new Cubism2PixiLive2DModelControls());
    handle.expression.setExpression('smile');
    aborted.reject(new TypeError('expression cache was destroyed'));
    await settleLoads();
    expect(queued).toEqual([]);
    expect(expressionManager.reserveExpressionIndex).toBe(-1);

    handle.expression.setExpression('sad');
    await settleLoads();
    expect(queued).toEqual([expressionManager.expressions[1]]);
  });

  it('does not apply a successfully loaded expression to a destroyed model', async () => {
    const { model, expressionManager, queued } = createModel();
    const load = deferred<Expression>();
    expressionManager.loadExpression.mockReturnValueOnce(load.promise);
    const handle = createHandle(model, new Cubism2PixiLive2DModelControls());
    handle.expression.setExpression('smile');
    model.destroyed = true;
    expressionManager.destroyed = true;

    load.resolve({ name: 'late-smile' });
    await settleLoads();
    expect(queued).toEqual([]);
  });

  it('preserves the existing expression when an obsolete idle reset is requested', async () => {
    const { model, expressionManager, queued } = createModel();
    const smile = expressionManager.expressions[0];
    expressionManager.currentExpression = smile;
    queued.push(smile);

    await new Cubism2PixiLive2DModelControls({ clock: () => null }).resetModelToIdle(model, {}, () => false);

    expect(queued).toEqual([smile]);
    expect(expressionManager.currentExpression).toBe(smile);
    expect(model.update).not.toHaveBeenCalled();
  });

  it('clears every concrete expression manager in a composite character', () => {
    const primary = createModel();
    const child = createModel();
    primary.queued.push(primary.expressionManager.expressions[0]);
    child.queued.push(child.expressionManager.expressions[1]);
    const composite = { getAllModels: () => [primary.model, child.model] };

    createHandle(composite, new Cubism2PixiLive2DModelControls()).quiesce();

    expect(primary.queued).toEqual([]);
    expect(child.queued).toEqual([]);
    expect(primary.expressionManager.currentExpression).toBe(primary.defaultExpression);
    expect(child.expressionManager.currentExpression).toBe(child.defaultExpression);
  });
});
