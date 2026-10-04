export interface IPlaybackAdapter {
  play(): void;
  pause(): void;
  seek(time: number, forceReconstruct?: boolean): Promise<void>;
  getCurrentTime(): number;
  getDuration(): number;
  setLoop(start: number, end: number): void;
  setLoopEnabled(v: boolean): void;
  setSpeed(s: number): void;
  subscribeTime(callback: (time: number) => void): () => void;
}
