import type { LayerName } from '../types/common';

export type StagePreviewResolution = 1 | 0.5 | 0.25;

export interface IStageAdapter {
  mount(container: HTMLElement): Promise<void>;
  setBackground(path: string, options?: { transition?: string }): Promise<void>;
  getLayer(name: LayerName): any;
  getWidth(): number;
  getHeight(): number;
  getCanvas(): HTMLCanvasElement;
  getApp(): any;
  getPreviewResolution(): StagePreviewResolution;
  setPreviewResolution(resolution: StagePreviewResolution): void;
  pauseTicker(): void;
  resumeTicker(): void;
}
