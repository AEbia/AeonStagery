import type { Application } from 'pixi.js';
import type { PreparedCompiledScene } from '../api/types/semantic-scene';
import type { WmdlConfigRegistry } from './WmdlConfigRegistry';
import { IsolatedLive2DSimulation, type CameraAnchorSamplingOptions } from './IsolatedLive2DSimulation';
export type { CameraAnchorPreparationResult, CameraAnchorSamplingOptions } from './IsolatedLive2DSimulation';

/** Owns historical geometry sampling independently of background snapshot Bake. */
export class CameraAnchorSampler {
  private readonly simulation: IsolatedLive2DSimulation;

  constructor(app: Application, registry?: WmdlConfigRegistry) {
    this.simulation = new IsolatedLive2DSimulation(app, registry);
  }

  prepareCameraAnchorsPrepared(scene: PreparedCompiledScene, paths: Map<string, string>, token: number, options?: CameraAnchorSamplingOptions) {
    return this.simulation.prepareCameraAnchorsPrepared(scene, paths, token, options);
  }

  cancel(): void { this.simulation.cancel(); }
  destroy(): void { this.simulation.destroy(); }
}
