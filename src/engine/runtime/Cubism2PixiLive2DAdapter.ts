import * as PIXI from 'pixi.js';
import type { Live2DRuntimeDescriptor } from '../Live2DRuntimeResolver';
import { getUnsupportedLive2DRuntimeMessage, isLive2DCubism2RuntimeAvailable } from '../Live2DRuntimeResolver';
import { waitForLive2DRuntimeBootstrap } from '../Live2DRuntimeAvailability';
import { createLive2DModelHandle, type Live2DModelHandle } from '../live2d/runtime/Live2DRuntimeControlModule';
import { Cubism2BakeRenderCore } from '../live2d/runtime/Cubism2BakeRenderCore';
import { registerSharedRuntimeClockProvider } from '../live2d/runtime/Live2DRuntimeClockCoordinator';
import { loadLive2DEngineModule } from '../Live2DEngineBridge';
import type {
  Live2DModelCreateOptions,
  Live2DRuntimeClock,
  Live2DRuntimeModelControls,
  Live2DRuntimeAdapter,
} from './Live2DRuntimeContracts';
import { Cubism2PixiLive2DModelControls } from './Cubism2PixiLive2DModelControls';

type Cubism2Module = {
  Live2DModel?: any;
  config?: any;
};

type Cubism2ModuleLoader = () => Promise<Cubism2Module>;

export const defaultCubism2RuntimeDescriptor: Live2DRuntimeDescriptor = {
  runtimeFamily: 'cubism2',
  adapterId: 'pixi-live2d-display-cubism2',
  supported: true,
};

export class Cubism2PixiLive2DAdapter implements Live2DRuntimeAdapter {
  public readonly id = 'pixi-live2d-display-cubism2';
  public readonly supported = true;
  private modelClass: any = null;
  private moduleConfig: any = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private readonly bakeCore = new Cubism2BakeRenderCore();
  private readonly controls: Cubism2PixiLive2DModelControls;

  constructor(
    // Must resolve to the same engine bundle whose Live2DPlugin is registered
    // as the render pipe — see Live2DEngineBridge.
    private readonly loadModule: Cubism2ModuleLoader = () => loadLive2DEngineModule(),
  ) {
    registerSharedRuntimeClockProvider(() => this.getClock());
    this.controls = new Cubism2PixiLive2DModelControls({
      maskSize: () => this.getConfig()?.cubism2?.maskSize ?? 1024,
      bakeCore: this.bakeCore,
      clock: () => this.getClock(),
    });
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      // Importing pixi-live2d-display/cubism2 without window.Live2D throws at
      // module-evaluation time and permanently poisons the dynamic-import
      // cache. When the Cubism 2.1 runtime is known-missing, fail with an
      // explicit message instead of touching the module graph.
      await waitForLive2DRuntimeBootstrap();
      if (!isLive2DCubism2RuntimeAvailable()) {
        throw new Error(getUnsupportedLive2DRuntimeMessage('live2d.min.js', {
          runtimeFamily: 'cubism2',
          adapterId: this.id,
          supported: false,
        }) ?? 'Cubism 2.1 runtime is unavailable.');
      }

      const module = await this.loadModule();
      this.modelClass = 'Live2DModel' in module ? module.Live2DModel ?? null : null;
      this.moduleConfig = 'config' in module ? module.config ?? null : this.modelClass?.config ?? null;

      const cubism2Config = this.getConfig()?.cubism2;
      if (cubism2Config) {
        cubism2Config.maskSize = 1024;
      }

      this.ready = true;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getModelClass(): any {
    return this.modelClass;
  }

  getConfig(): any {
    return this.modelClass?.config ?? this.moduleConfig;
  }

  getControls(): Live2DRuntimeModelControls {
    return this.controls;
  }

  createModelHandle(
    id: string,
    model: any,
    runtime: Live2DRuntimeDescriptor = defaultCubism2RuntimeDescriptor,
  ): Live2DModelHandle {
    return createLive2DModelHandle({
      id,
      model,
      runtime,
      controls: this.controls,
    });
  }

  async createModel(modelUrl: string, options: Live2DModelCreateOptions): Promise<any> {
    await this.init();
    if (!this.modelClass?.from) {
      throw new Error('Cubism 2 Live2DModel class is not available.');
    }
    return this.modelClass.from(modelUrl, options);
  }

  getUnsupportedMessage(modelPath: string): string | null {
    return getUnsupportedLive2DRuntimeMessage(modelPath, {
      runtimeFamily: 'cubism2',
      adapterId: this.id,
      supported: isLive2DCubism2RuntimeAvailable(),
    });
  }

  getClock(): Live2DRuntimeClock | null {
    if (typeof window === 'undefined') return null;
    const utSystem = (window as any).UtSystem;
    if (!utSystem || typeof utSystem.getUserTimeMSec !== 'function') return null;
    return utSystem;
  }

  createFallbackModel(renderer?: any): any {
    const graphics = new PIXI.Graphics();
    graphics.beginFill(0x222222, 0.8);
    graphics.lineStyle(6, 0xffaa00);
    graphics.drawRect(0, 0, 800, 1200);

    // Draw a cross
    graphics.moveTo(0, 0);
    graphics.lineTo(800, 1200);
    graphics.moveTo(800, 0);
    graphics.lineTo(0, 1200);
    graphics.endFill();

    const tex = typeof renderer?.generateTexture === 'function'
      ? renderer.generateTexture(graphics)
      : PIXI.Texture.EMPTY;
    const model: any = new PIXI.Sprite(tex);

    // Mock the runtime surface the adapter's own controls call into, so the
    // placeholder survives the standard lifecycle hooks (update, snapshot,
    // motion teardown) without crashing.
    model.update = () => {};
    model.internalModel = {
      coreModel: {
        getParameterValues: () => [],
        getPartOpacities: () => [],
        saveParam: () => {},
      },
      motionManager: {
        stopAllMotions: () => {},
        loadMotion: async () => {},
        startMotion: async () => {},
      },
      settings: { motions: {} },
    };
    return model;
  }

  disposeBakeRenderTexture(): void {
    this.bakeCore.disposeBakeRenderTexture();
  }
}
