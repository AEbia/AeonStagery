import type { Application } from 'pixi.js';
import type { PreparedCompiledScene } from '../api/types/semantic-scene';
import type { Snapshot } from './SnapshotStore';
import type { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { IsolatedLive2DSimulation, type Live2DSnapshotResult } from './IsolatedLive2DSimulation';

export type BakeResult = Live2DSnapshotResult;

/** Produces only Live2D snapshots; camera preparation is owned separately. */
export class BakeEngine {
  private readonly simulation: IsolatedLive2DSimulation;

  constructor(app: Application, registry?: WmdlConfigRegistry) {
    this.simulation = new IsolatedLive2DSimulation(app, registry);
  }

  bakePrepared(scene: PreparedCompiledScene, paths: Map<string, string>, token: number): Promise<BakeResult> {
    return this.simulation.bakePrepared(scene, paths, token);
  }

  bakePreparedRange(
    scene: PreparedCompiledScene, paths: Map<string, string>, token: number,
    start: number, end: number, precision: number, seed?: Snapshot, silent = false,
  ): Promise<BakeResult> {
    return this.simulation.bakePreparedRange(scene, paths, token, start, end, precision, seed, silent);
  }

  cancel(): void { this.simulation.cancel(); }
  destroy(): void { this.simulation.destroy(); }
  waitForLoads(): Promise<void> { return this.simulation.waitForLoads(); }
}
