import type * as PIXI from 'pixi.js';

const preparations = new WeakMap<PIXI.Container, (renderer: PIXI.Renderer) => void>();

/** Settle native geometry before stage sizing and camera anchor capture.
 * C2 vertices are unavailable until its context-bound preparation has run.
 * Composite models register that preparation on each concrete child.
 */
export function prepareLive2DGeometry(model: PIXI.Container, renderer: PIXI.Renderer): void {
  preparations.get(model)?.(renderer);
  for (const child of model.children) prepareLive2DGeometry(child, renderer);
}

/** Parent filters measure their children before executing the Live2D pipe.
 * Prepare at Pixi's frame hook so those filters see the current drawable bounds,
 * including parts outside the authored canvas. Keep canvas anchors unchanged.
 */
export function installLive2DRenderPreparation(
  model: PIXI.Container,
  prepare: (renderer: PIXI.Renderer) => void,
): void {
  if (preparations.has(model)) return;
  preparations.set(model, prepare);
  const previous = model.onRender;
  model.onRender = (renderer) => {
    previous?.call(model, renderer);
    prepare(renderer);
  };
}
