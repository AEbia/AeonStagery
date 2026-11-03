/** Runs only inside the preview frame: SDK clocks, GL tables and assets stay in that realm. */
import * as PIXI from 'pixi.js';
import { ensureLive2DRenderPipe } from './Live2DEngineBridge';
import { getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import { Live2DModelResources } from './Live2DModelResources';
import { WmdlConfigRegistry } from './WmdlConfigRegistry';
import {
  advanceLive2DStageClock,
  type Live2DModelHandle,
} from './live2d/runtime/Live2DRuntimeControlModule';
import type { Live2DPerformanceKind } from './runtime/Live2DRuntimeContracts';

export class Live2DPerformancePreview {
  // Absolute URLs are resolved by the editor before crossing into this realm.
  private readonly resources = new Live2DModelResources(() => '', undefined, 'bake');
  private readonly app = new PIXI.Application();
  private handle: Live2DModelHandle | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  private initialized = false;
  private version = 0;
  private fitModel: (() => void) | null = null;

  private readonly resize = () => {
    if (!this.initialized || this.disposed) return;
    this.app.renderer.resize(this.host.clientWidth || 300, this.host.clientHeight || 340);
    this.fitModel?.();
  };

  constructor(private readonly host: HTMLElement, private readonly modelUrl: string) {}

  async play(kind: Live2DPerformanceKind, key: string): Promise<void> {
    const version = ++this.version;
    const isCurrent = () => !this.disposed && version === this.version;
    this.loading ??= this.load();
    await this.loading;
    if (!isCurrent()) return;
    const handle = this.handle;
    if (!handle) throw new Error('模型加载失败，请重新打开预览。');
    this.app.stop();
    handle.resetRuntimeState({ pose: 'neutral', keepFocus: false });
    if (kind === 'motion') {
      const result = await handle.performance.transition({
        motionKey: key, priority: 3, offsetSeconds: 0, sceneTimeSeconds: 0,
        clearQueueFirst: true, isCurrent,
      });
      if (!isCurrent()) return;
      if (result.status !== 'started') throw new Error(`找不到动作：${key}`);
    } else {
      if (!handle.expression.getAvailableExpressions().includes(key)) throw new Error(`找不到表情：${key}`);
      await handle.expression.restoreAtSceneTime(key, 0, null, isCurrent);
    }
    if (isCurrent()) this.app.start();
  }

  private async load(): Promise<void> {
    const { modelUrl } = this;
    const isCurrent = () => !this.disposed;
    await ensureLive2DRenderPipe();
    if (!isCurrent()) return;
    await this.app.init({
      width: this.host.clientWidth || 300, height: this.host.clientHeight || 340,
      preference: 'webgl', backgroundAlpha: 0, antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true,
      autoStart: false, sharedTicker: false,
    });
    this.initialized = true;
    if (!isCurrent()) { this.destroyApp(); return; }
    // Keep this auxiliary renderer's work bounded on high-refresh-rate displays.
    this.app.ticker.maxFPS = 60;
    this.host.appendChild(this.app.canvas);
    // The parent positions and sizes the iframe; its viewport emits resize when those bounds change.
    window.addEventListener('resize', this.resize);
    // WMDL child references are local to the wrapper, as in scene hydration.
    if (/\.wmdl$/i.test(modelUrl)) {
      const response = await fetch(modelUrl);
      if (!response.ok) throw new Error('组合模型文件无法读取。');
      const config: unknown = await response.json();
      if (!config || typeof config !== 'object' || !('modelRelativePath' in config)
        || typeof config.modelRelativePath !== 'string') throw new Error('组合模型配置缺少主模型。');
      const registry = new WmdlConfigRegistry();
      const subModels = 'subModels' in config && Array.isArray(config.subModels) ? config.subModels : [];
      registry.register(modelUrl, {
        modelRelativePath: new URL(config.modelRelativePath, modelUrl).href,
        subModels: subModels.map((sub: unknown) => {
          if (!sub || typeof sub !== 'object' || !('modelRelativePath' in sub)
            || typeof sub.modelRelativePath !== 'string') throw new Error('组合模型子模型路径无效。');
          return { ...sub, modelRelativePath: new URL(sub.modelRelativePath, modelUrl).href };
        }),
      });
      this.resources.setWmdlConfigRegistry(registry);
    }
    if (!isCurrent()) return;
    await this.resources.loadCharacter('preview', modelUrl, async (loaded) => {
      const current = () => isCurrent() && loaded.isCurrent();
      const handle = getLive2DRuntimeAdapter(loaded.runtime).createModelHandle('preview', loaded.model, loaded.runtime);
      const result = await handle.initialize({ mode: 'live', isCurrent: current });
      if (result.status !== 'ready' || !current()) return;
      handle.bindRuntimeSource({ mode: 'live', injectedParamsSource: { injectedParams: {} }, isCurrent: current });
      const model = loaded.model;
      model.visible = true;
      model.alpha = 1;
      const bounds = model.getLocalBounds();
      this.fitModel = () => {
        const scale = Math.max(0.001, Math.min((this.app.screen.width - 24) / Math.max(1, bounds.width),
          (this.app.screen.height - 24) / Math.max(1, bounds.height)));
        model.scale.set(scale);
        model.position.set((this.app.screen.width - bounds.width * scale) / 2 - bounds.x * scale,
          (this.app.screen.height - bounds.height * scale) / 2 - bounds.y * scale);
      };
      this.resize();
      this.app.stage.addChild(model);
      this.handle = handle;
      this.app.ticker.add((ticker) => {
        const deltaMs = Math.min(50, ticker.deltaMS);
        advanceLive2DStageClock(deltaMs);
        handle.frame.submit({ deltaMs, shouldAdvance: true, isCurrent: current });
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.version++;
    window.removeEventListener('resize', this.resize);
    this.fitModel = null;
    this.resources.close();
    this.destroyApp();
  }

  private destroyApp(): void {
    if (!this.initialized) return;
    this.initialized = false;
    this.app.destroy(true, { children: true, texture: false, textureSource: false });
  }
}
