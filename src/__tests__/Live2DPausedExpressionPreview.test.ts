import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import Live2DManager from '../engine/Live2DManager';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';

/**
 * Paused expression preview (ADR-0019).
 *
 * While the timeline is paused the inspector still has to show the expression
 * the user just picked. The Cubism 3/4/5 adapter cannot do that by starting an
 * expression motion — that would advance scene time and accumulate motion
 * fades — so Live2DManager re-evaluates the current frame at the same motion
 * timestamp instead. These tests pin that branch and its guards: the frame is
 * re-evaluated only for the character that is still the preview's target, and
 * only through the seek-capable Cubism adapter.
 */

const CUBISM_PIXI = 'untitled-pixi-live2d-engine-cubism';

function createManager() {
  const setExpressionForSeek = vi.fn(async () => {});
  const advanceFrame = vi.fn();
  const controls = mockControls({ setExpressionForSeek, advanceFrame });
  vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(
    mockAdapter({ getControls: () => controls }) as any,
  );
  return { manager: new Live2DManager(), controls, setExpressionForSeek, advanceFrame };
}

function addCharacter(manager: Live2DManager, id: string, adapterId: string, model: any = {}) {
  const entry: any = {
    id,
    model,
    runtime: { runtimeFamily: adapterId === CUBISM_PIXI ? 'cubism3-plus' : 'cubism2', adapterId, supported: true },
    config: {},
    injectedParams: {},
  };
  (manager as any).characters.set(id, entry);
  return entry;
}

describe('Live2D paused expression preview', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-evaluates the paused frame without starting an expression motion', async () => {
    const { manager, setExpressionForSeek, advanceFrame } = createManager();
    const model = {};
    addCharacter(manager, 'hero', CUBISM_PIXI, model);
    manager.setAutoUpdate(false);

    manager.setExpression('hero', 'smile');

    await vi.waitFor(() => expect(setExpressionForSeek).toHaveBeenCalledTimes(1));
    // Infinity asks the model for the expression's final pose; the frame is then
    // re-evaluated at delta 0 so the preview cannot advance the scene.
    expect(setExpressionForSeek).toHaveBeenCalledWith(model, 'smile', Number.POSITIVE_INFINITY);
    await vi.waitFor(() => expect(advanceFrame).toHaveBeenCalledTimes(1));
    expect(advanceFrame).toHaveBeenCalledWith(model, 0);
  });

  it('drops the superseded preview and keeps the latest one', async () => {
    const pending: Array<() => void> = [];
    const { manager, setExpressionForSeek, advanceFrame } = createManager();
    const model = {};
    addCharacter(manager, 'hero', CUBISM_PIXI, model);
    manager.setAutoUpdate(false);
    setExpressionForSeek.mockImplementation(() => new Promise<void>((done) => { pending.push(done); }));

    manager.setExpression('hero', 'smile');
    manager.setExpression('hero', 'angry');
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    pending[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(advanceFrame).not.toHaveBeenCalled();

    pending[1]();
    await vi.waitFor(() => expect(advanceFrame).toHaveBeenCalledTimes(1));
    expect(advanceFrame).toHaveBeenCalledWith(model, 0);
  });

  it('drops the preview when the character was swapped before it resolved', async () => {
    let resolvePreview!: () => void;
    const { manager, setExpressionForSeek, advanceFrame } = createManager();
    addCharacter(manager, 'hero', CUBISM_PIXI, {});
    manager.setAutoUpdate(false);
    setExpressionForSeek.mockImplementationOnce(
      () => new Promise<void>((done) => { resolvePreview = done; }),
    );

    manager.setExpression('hero', 'smile');
    addCharacter(manager, 'hero', CUBISM_PIXI);
    resolvePreview();
    await vi.waitFor(() => expect(setExpressionForSeek).toHaveBeenCalledTimes(1));

    expect(advanceFrame).not.toHaveBeenCalled();
  });

  it('keeps the live handle path while the timeline is running', () => {
    const { manager, setExpressionForSeek, advanceFrame, controls } = createManager();
    const entry = addCharacter(manager, 'hero', CUBISM_PIXI, {});
    entry.runtimeHandle = { expression: { setExpression: vi.fn() } };

    manager.setExpression('hero', 'smile');

    expect(entry.runtimeHandle.expression.setExpression).toHaveBeenCalledWith('smile');
    expect(setExpressionForSeek).not.toHaveBeenCalled();
    expect(advanceFrame).not.toHaveBeenCalled();
    expect(controls.setExpression).not.toHaveBeenCalled();
  });

  it('falls back to the direct controls when the paused runtime cannot seek', () => {
    const { manager, setExpressionForSeek, controls } = createManager();
    delete (controls as any).setExpressionForSeek;
    const model = {};
    addCharacter(manager, 'hero', 'pixi-live2d-display-cubism2', model);
    manager.setAutoUpdate(false);

    manager.setExpression('hero', 'smile');

    expect(controls.setExpression).toHaveBeenCalledWith(model, 'smile');
    expect(setExpressionForSeek).not.toHaveBeenCalled();
  });

  it('reports a failed preview instead of throwing into the character API', async () => {
    const { manager, setExpressionForSeek, advanceFrame } = createManager();
    addCharacter(manager, 'hero', CUBISM_PIXI, {});
    manager.setAutoUpdate(false);
    setExpressionForSeek.mockRejectedValueOnce(new Error('expression file missing'));

    expect(() => manager.setExpression('hero', 'smile')).not.toThrow();

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(advanceFrame).not.toHaveBeenCalled();
  });
});
