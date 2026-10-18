/** Runtime-only geometry; character x/y use stage pixels, environment x/y are normalized. */
export interface TransformPreviewUpdates {
  x?: number;
  y?: number;
  z?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
}

export interface IPlaybackAdapter {
  play(): void;
  pause(): void;
  seek(time: number, forceReconstruct?: boolean): Promise<void>;
  getCurrentTime(): number;
  previewTransform?(id: string, updates: TransformPreviewUpdates): void;
  previewEnvironmentLayerTransform?(layerId: string, updates: TransformPreviewUpdates): void;
  getDuration(): number;
  setLoop(start: number, end: number): void;
  setLoopEnabled(v: boolean): void;
  setSpeed(s: number): void;
  subscribeTime(callback: (time: number) => void): () => void;
}
