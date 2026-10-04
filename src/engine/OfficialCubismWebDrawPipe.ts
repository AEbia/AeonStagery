/**
 * AeonStagery — official Cubism Web (Cubism 3+) per-frame draw seam (PixiJS 8)
 *
 * PixiJS 8 removed the v7 `Container.render(renderer)` boundary entirely. The
 * official Cubism Web runtime draws each frame into its OWN offscreen WebGL
 * canvas (`OfficialCubismWebModelInstance` wraps it in a `PIXI.Sprite` via a
 * canvas `Texture`), and under v7 the wrapper's `render()` override was what
 * drove `drawToCanvas()` + `refreshTexture()` once per render pass. Under v8
 * the pipeline never calls that override — it collects an instruction tree
 * (`collectRenderables`) and executes it through render pipes
 * (`renderPipes[id].execute(instruction)`). The consequence was that live
 * playback froze on the load frame (only seek/bake redraw explicitly), and
 * any lingering call into the dead override hit `super.render(renderer)` —
 * `Container.prototype.render` is `undefined` in v8, i.e.
 * `TypeError: ... .render is not a function`.
 *
 * This module restores the v7 semantics at the actual v8 boundary:
 *
 *  1. `OfficialCubismWebModelInstance.collectRenderables()` pushes a draw
 *     instruction through this pipe right before its sprite children are
 *     collected, so the canvas refresh executes in the correct order within
 *     every render pass (live stage pass, bake composition pass, filter
 *     passes alike).
 *  2. The instruction object persists in the render group's cached
 *     instruction tree; v8 re-executes instructions EVERY frame even when
 *     only transforms changed and the tree was not rebuilt — exactly the
 *     cadence at which v7 used to invoke `render()`.
 *
 * The draw runs on the model's own WebGL context (offscreen canvas with
 * `preserveDrawingBuffer: true`); `refreshTexture()` only flags the texture
 * source dirty — the actual `texImage2D` upload happens later, when the
 * sprite's batch flush binds it. So unlike the Cubism 2 `renderLive2D` seam,
 * no shared-context GL resets are needed. The only ordering we must
 * guarantee is that sprites collected before this instruction do not swallow
 * our sprite into their batch (that batch would flush and upload BEFORE the
 * canvas is refreshed — a permanent one-frame lag), hence `batch.break()`.
 */
import * as PIXI from 'pixi.js';

/** Name under which the pipe is registered on `renderer.renderPipes`. */
export const OFFICIAL_CUBISM_DRAW_PIPE_ID = 'officialCubismWebDraw';

/** The subset of the wrapper the pipe executes against. */
export interface OfficialCubismDrawable {
  drawForRenderPass(renderer: any): void;
}

/**
 * A collected instruction referencing one wrapper. Plain data + the
 * `renderPipeId` tag the v8 executor dispatches on. `canBundle: false` keeps
 * it out of bundled execution paths (mirrors the vendor Live2D prepare
 * instruction).
 */
class OfficialCubismWebDrawInstruction {
  public readonly renderPipeId = OFFICIAL_CUBISM_DRAW_PIPE_ID;
  public readonly canBundle = false;

  constructor(public readonly container: OfficialCubismDrawable) {}
}

/**
 * Render pipe executing `OfficialCubismWebDrawInstruction`s. Registered as a
 * `WebGLPipes` extension BEFORE the renderer is created (StageManager does
 * this next to `ensureLive2DRenderPipe()`); `ensureOfficialCubismWebDrawPipe`
 * covers renderers that were created without the registration (tests,
 * alternative boot paths).
 */
export class OfficialCubismWebDrawPipe {
  /**
   * Lazy on purpose: several suites import the display stack against trimmed
   * `pixi.js` mocks without `ExtensionType`. Reading it in a static field
   * would blow up at module-evaluation time; `extensions.add()` only reads
   * this descriptor when registration actually runs.
   */
  static get extension() {
    return {
      type: [PIXI.ExtensionType.WebGLPipes],
      name: OFFICIAL_CUBISM_DRAW_PIPE_ID,
    };
  }

  constructor(private readonly renderer: any) {}

  /** Append this wrapper's per-frame canvas refresh to the instruction set. */
  addDraw(container: OfficialCubismDrawable, instructionSet: any): void {
    this.renderer?.renderPipes?.batch?.break?.(instructionSet);
    instructionSet.add(new OfficialCubismWebDrawInstruction(container));
  }

  /** Executed once per render pass, before this wrapper's sprite renders. */
  execute(instruction: OfficialCubismWebDrawInstruction): void {
    instruction.container?.drawForRenderPass?.(this.renderer);
  }

  // Interface parity with the built-in render pipes (the executor only
  // touches execute/addDraw here; the rest exist so v8 housekeeping never
  // reaches for a missing method).
  updateRenderable(): void {}
  destroyRenderable(): void {}
  validateRenderable(): boolean {
    return false;
  }
  destroy(): void {}
}

let drawPipeRegistered = false;

/**
 * Register the pipe extension. Must run before any `Application.init()` /
 * `autoDetectRenderer()` so the WebGL renderer instantiates the pipe through
 * the normal extension machinery (and wires it into the destroy runner).
 * Idempotent.
 */
export function registerOfficialCubismWebDrawPipe(): void {
  if (drawPipeRegistered) return;
  // Tolerate trimmed pixi.js mocks (unit tests) that omit the extension
  // machinery; those renderers never run a real WebGL pipeline anyway, and
  // `ensureOfficialCubismWebDrawPipe` covers any renderer created without it.
  if (!PIXI.extensions || !PIXI.ExtensionType) return;
  PIXI.extensions.add(OfficialCubismWebDrawPipe as any);
  drawPipeRegistered = true;
}

/**
 * Fetch the pipe for a renderer, lazily creating it when the extension was
 * never registered (the pipe holds no GL resources, so an unregistered
 * instance is harmless; it just skips the destroy runner).
 */
export function ensureOfficialCubismWebDrawPipe(renderer: any): OfficialCubismWebDrawPipe | null {
  const pipes = renderer?.renderPipes;
  if (!pipes) return null;
  let pipe: OfficialCubismWebDrawPipe | undefined = pipes[OFFICIAL_CUBISM_DRAW_PIPE_ID];
  if (!pipe) {
    pipe = new OfficialCubismWebDrawPipe(renderer);
    pipes[OFFICIAL_CUBISM_DRAW_PIPE_ID] = pipe;
  }
  return pipe;
}

/** Test-only: reset the registration flag so the seam can be re-exercised. */
export function __resetOfficialCubismWebDrawPipeRegistrationForTests(): void {
  drawPipeRegistered = false;
}
