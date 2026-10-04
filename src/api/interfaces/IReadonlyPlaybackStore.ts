export interface IReadonlyPlaybackStore {
  readonly playing: boolean;
  readonly duration: number;
  readonly engineStatus: string;
  subscribe(listener: () => void): () => void;
}
