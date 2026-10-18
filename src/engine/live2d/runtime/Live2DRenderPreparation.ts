import type * as PIXI from 'pixi.js';

const preparedModels = new WeakSet<PIXI.Container>();

/** Parent filters measure their children before executing the Live2D pipe.
 * Prepare at Pixi's frame hook so those filters see the current drawable bounds,
 * including parts outside the authored canvas. Keep canvas anchors unchanged.
 */
export function installLive2DRenderPreparation(
  model: PIXI.Container,
  prepare: (renderer: PIXI.Renderer) => void,
): void {
  if (preparedModels.has(model)) return;
  preparedModels.add(model);
  const previous = model.onRender;
  model.onRender = (renderer) => {
    previous?.call(model, renderer);
    prepare(renderer);
  };
}
