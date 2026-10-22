import { CameraAnchorSampler, type CameraAnchorPreparationResult, type CameraAnchorSamplingOptions } from './CameraAnchorSampler';
import type { PreparedCompiledScene } from '../api/types/semantic-scene';
import { stageManager } from './StageManager';
import type { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { preparedSceneToRuntimeTimelineScene } from './PreparedRuntimeScene';

/** Isolated character-runtime boundary, also usable by other prepared-scene consumers. */
export interface CameraAnchorPreparer {
  prepareCameraAnchorsPrepared(scene: PreparedCompiledScene, paths: Map<string, string>, token: number, options?: CameraAnchorSamplingOptions): Promise<CameraAnchorPreparationResult>;
  cancel(): void;
  destroy(): void;
}
export type CameraAnchorPreparerFactory = () => CameraAnchorPreparer;

/** Owns readiness and disposal independently of live characters and background snapshot baking. */
export class CameraHistoricalRuntime {
  private worker: CameraAnchorPreparer | null = null;
  private registry: WmdlConfigRegistry | undefined;
  private generation = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private scene: PreparedCompiledScene | null = null;
  private required = false;
  private requiredTime: (time: number) => number = () => 0;
  private ready: { scene: PreparedCompiledScene; throughTime: number; requiredTime: (time: number) => number; anchorTrajectories: NonNullable<CameraAnchorPreparationResult['anchorTrajectories']>; trajectoryRevision: string | number } | null = null;

  constructor(private readonly factory?: CameraAnchorPreparerFactory) {}

  setWmdlConfigRegistry(registry: WmdlConfigRegistry): void {
    this.dispose();
    this.registry = registry;
  }

  get input() { return this.ready; }

  cancel(): void {
    this.cancelPreparation();
    this.ready = null;
    this.scene = null;
  }

  /** Cancel only unpublished work; the committed scene still owns its history. */
  cancelPreparation(): void {
    this.generation++;
    this.worker?.cancel();
  }

  covers(time: number): boolean {
    return this.ready !== null
      && this.ready.requiredTime(time) <= this.ready.throughTime + 1e-9;
  }

  async prepare(scene: PreparedCompiledScene, required: boolean, time = scene.durationSeconds): Promise<boolean> {
    this.cancelPreparation();
    this.scene = scene;
    this.required = required;
    this.requiredTime = historyRequirements(scene);
    return this.prepareThrough(time, this.generation, false);
  }

  ensureAt(time: number, lookAheadSeconds = 0): Promise<boolean> {
    if (this.ready?.scene === this.scene && this.covers(time)) return Promise.resolve(true);
    return this.prepareThrough(time + lookAheadSeconds, this.generation);
  }

  private prepareThrough(time: number, generation: number, reuseExisting = true): Promise<boolean> {
    const scene = this.scene;
    if (!scene) return Promise.resolve(false);
    const requiredTime = this.requiredTime;
    const throughTime = this.required ? requiredTime(time) : -Infinity;
    if (!this.required || throughTime === -Infinity) {
      this.ready = { scene, requiredTime, throughTime: this.required ? -Infinity : Infinity, anchorTrajectories: [], trajectoryRevision: generation };
      return Promise.resolve(true);
    }
    // Serialize isolated model access, including extensions requested by seek.
    // Each extension is a canonical prefix; query order never seeds a new pose.
    const previous = this.pending;
    const preparing = (async () => {
      await previous.catch(() => {});
      if (generation !== this.generation) return false;
      if (reuseExisting && this.ready?.scene === scene && throughTime <= this.ready.throughTime + 1e-9) return true;
      const worker = this.worker ??= this.factory?.() ?? new CameraAnchorSampler(stageManager.getApp(), this.registry);
      const result = await worker.prepareCameraAnchorsPrepared(scene, new Map(), generation, { throughTime, cameraOnly: true });
      if (generation !== this.generation) return false;
      if (!result.anchorTrajectories || result.anchorRevision === undefined) {
        throw new Error('Historical camera anchor preparation did not publish a complete trajectory bundle.');
      }
      this.ready = { scene, requiredTime, throughTime: result.preparedThroughTime ?? scene.durationSeconds,
        anchorTrajectories: result.anchorTrajectories, trajectoryRevision: result.anchorRevision };
      return true;
    })();
    this.pending = preparing;
    return preparing;
  }

  dispose(): void {
    this.cancel();
    this.worker?.destroy();
    this.worker = null;
  }
}

/** The past that can influence a camera query, excluding unrelated future poses. */
function historyRequirements(scene: PreparedCompiledScene): (time: number) => number {
  const actions = preparedSceneToRuntimeTimelineScene(scene).timeline
    .map((action, index) => ({ action, index }))
    .sort((a, b) => (a.action.time ?? 0) - (b.action.time ?? 0) || a.index - b.index);
  return (time) => {
    time = Math.max(0, Math.min(time, scene.durationSeconds));
    let required = -Infinity;
    let followEnd: number | null = null;
    const finishFollow = (at: number) => {
      if (followEnd !== null) required = Math.max(required, Math.min(at, followEnd));
      followEnd = null;
    };
    for (const { action } of actions) {
      const start = action.time ?? 0;
      if (start > time) break;
      const params = action.params;
      const properties = params._cameraProperties;
      const writesPosition = Array.isArray(properties) && properties.includes('position');
      if (action.action === 'cameraFollow') {
        finishFollow(start);
        const duration = params.duration;
        followEnd = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? start + duration : Infinity;
        required = Math.max(required, start);
      } else if (action.action === 'cameraUnfollow' || action.action === 'cameraReset' || writesPosition) {
        finishFollow(start);
      }
      if (action.action === 'cameraMotion' && writesPosition) {
        const focus = params.focus;
        if ((typeof focus === 'object' && focus !== null && 'character' in focus)
          || typeof params.targetCharacter === 'string' || typeof params.characterId === 'string') {
          required = Math.max(required, start);
        }
      }
    }
    finishFollow(time);
    return required;
  };
}
