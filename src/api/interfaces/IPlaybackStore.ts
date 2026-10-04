import type { IReadonlyPlaybackStore } from './IReadonlyPlaybackStore';

export interface IPlaybackStore extends IReadonlyPlaybackStore {
  setPlaying(v: boolean): void;
  setDuration(d: number): void;
  setEngineStatus(s: string): void;
}
