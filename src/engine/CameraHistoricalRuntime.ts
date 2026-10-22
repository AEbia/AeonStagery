import { BakeEngine, type BakeResult } from './BakeEngine';
import type { PreparedCompiledScene } from '../api/types/semantic-scene';
import type { CameraAnchorTrajectory } from './CameraChannelEvaluator';
import { stageManager } from './StageManager';
import type { WmdlConfigRegistry } from './WmdlConfigRegistry';

/** Isolated character-runtime boundary, also usable by other prepared-scene consumers. */
export interface CameraAnchorPreparer {
  prepareCameraAnchorsPrepared(scene: PreparedCompiledScene, paths: Map<string, string>, token: number): Promise<BakeResult>;
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
  private ready: { anchorTrajectories: readonly CameraAnchorTrajectory[]; trajectoryRevision: string | number } | null = null;

  constructor(private readonly factory?: CameraAnchorPreparerFactory) {}

  setWmdlConfigRegistry(registry: WmdlConfigRegistry): void {
    this.dispose();
    this.registry = registry;
  }

  get input() { return this.ready; }

  cancel(): void {
    this.generation++;
    this.ready = null;
    this.worker?.cancel();
  }

  async prepare(scene: PreparedCompiledScene, required: boolean): Promise<boolean> {
    this.cancel();
    const generation = this.generation;
    if (!required) {
      this.ready = { anchorTrajectories: [], trajectoryRevision: generation };
      return true;
    }
    // Serialize reuse of isolated models: cancellation can settle after an async resource load.
    const previous = this.pending;
    const preparing = (async () => {
      await previous.catch(() => {});
      if (generation !== this.generation) return false;
      const worker = this.worker ??= this.factory?.() ?? new BakeEngine(stageManager.getApp(), this.registry);
      const result = await worker.prepareCameraAnchorsPrepared(scene, new Map(), generation);
      if (generation !== this.generation) return false;
      if (!result.anchorTrajectories || result.anchorRevision === undefined) {
        throw new Error('Historical camera anchor preparation did not publish a complete trajectory bundle.');
      }
      this.ready = { anchorTrajectories: result.anchorTrajectories, trajectoryRevision: result.anchorRevision };
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
