import { stageManager } from '../../engine/StageManager';
import { lightingSystem } from '../../engine/LightingSystem';
import type { LayerName } from '../../api/types/common';
import type { IStageAdapter, StagePreviewResolution } from '../../api/interfaces';

export class StageAdapter implements IStageAdapter {
  async mount(container: HTMLElement): Promise<void> {
    await stageManager.init(container);
    lightingSystem.init();
  }

  async setBackground(path: string, options?: { transition?: string }): Promise<void> {
    await stageManager.setBackground(path, { transition: 'none' as any, ...options } as any);
  }

  getLayer(name: LayerName): any {
    return stageManager.getLayer(name);
  }

  getWidth(): number {
    return stageManager.getWidth();
  }

  getHeight(): number {
    return stageManager.getHeight();
  }

  getCanvas(): HTMLCanvasElement {
    return stageManager.getCanvas();
  }

  getApp(): any {
    return stageManager.getApp();
  }

  getPreviewResolution(): StagePreviewResolution {
    return stageManager.getPreviewResolution();
  }

  setPreviewResolution(resolution: StagePreviewResolution): void {
    stageManager.setPreviewResolution(resolution);
  }

  pauseTicker(): void {
    stageManager.pauseTicker();
  }

  resumeTicker(): void {
    stageManager.resumeTicker();
  }
}
