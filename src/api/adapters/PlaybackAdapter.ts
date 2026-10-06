import type { PlaybackStore } from '../../ui/store/PlaybackStore';
import type { IPlaybackAdapter } from '../../api/interfaces';

interface PlaybackEngine {
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  onPlayingChange(callback: (playing: boolean) => void): () => void;
  seek(time: number, forceReconstruct?: boolean): Promise<void>;
  setLoop(start: number, end: number): void;
  setLoopEnabled(v: boolean): void;
  setSpeed(s: number): void;
  getCurrentTime(): number;
  previewTransform?(id: string, updates: Partial<any>): void;
  getDuration(): number;
  setSilentMode(v: boolean): void;
  getBasePath(): string;
  getMasterTimeline(): any;
  setBasePath?(path: string): void;
}

export class PlaybackAdapter implements IPlaybackAdapter {
  private store: PlaybackStore;
  private engine: PlaybackEngine;
  private unsubscribes: (() => void)[] = [];
  private _timeCallbacks = new Set<(time: number) => void>();
  private _timeSyncActive = false;
  private _timeSyncHandle: number | null = null;
  private _seekToken = 0;

  constructor(store: PlaybackStore, engine: PlaybackEngine) {
    this.store = store;
    this.engine = engine;
    this.unsubscribes.push(engine.onPlayingChange(playing => this.syncPlayingState(playing)));
    this.syncPlayingState(engine.isPlaying());
  }

  play(): void {
    this.engine.play();
    this.syncPlayingState(this.engine.isPlaying());
  }

  pause(): void {
    this.engine.pause();
    this.syncPlayingState(this.engine.isPlaying());
  }

  async seek(time: number, forceReconstruct?: boolean): Promise<void> {
    const seekToken = ++this._seekToken;
    this.dispatchTimeUpdate(time);
    if (forceReconstruct !== undefined) {
      await (this.engine as any).seek(time, forceReconstruct);
    } else {
      await (this.engine as any).seek(time);
    }
    if (seekToken !== this._seekToken) {
      return;
    }
    this.dispatchTimeUpdate(this.engine.getCurrentTime());
  }

  getCurrentTime(): number {
    return this.engine.getCurrentTime();
  }

  setLoop(start: number, end: number): void {
    this.engine.setLoop(start, end);
  }

  setLoopEnabled(v: boolean): void {
    this.engine.setLoopEnabled(v);
  }

  setSpeed(s: number): void {
    this.engine.setSpeed(s);
  }

  previewTransform(id: string, updates: Partial<any>): void {
    if (this.engine.previewTransform) {
      this.engine.previewTransform(id, updates);
    }
  }

  dispatchTimeUpdate(time: number): void {
    for (const cb of this._timeCallbacks) {
      cb(time);
    }
  }

  subscribeTime(callback: (time: number) => void): () => void {
    this._timeCallbacks.add(callback);
    return () => {
      this._timeCallbacks.delete(callback);
    };
  }

  getDuration(): number { return this.engine.getDuration(); }
  setSilentMode(v: boolean): void { this.engine.setSilentMode(v); }
  getBasePath(): string { return this.engine.getBasePath(); }
  getMasterTimeline(): any { return this.engine.getMasterTimeline(); }
  setBasePath(path: string): void {
    if (this.engine.setBasePath) {
      this.engine.setBasePath(path);
    }
  }

  dispose(): void {
    this.stopTimeSync();
    this._timeCallbacks.clear();
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
  }

  private syncPlayingState(playing: boolean): void {
    this.store._setPlaying(playing);
    if (playing) {
      if (!this._timeSyncActive) {
        this.startTimeSync();
      }
    } else {
      this.stopTimeSync();
      this.dispatchTimeUpdate(this.engine.getCurrentTime());
    }
  }

  private startTimeSync(): void {
    if (this._timeSyncHandle !== null || this._timeSyncActive) {
      this.stopTimeSync();
    }
    this._timeSyncActive = true;
    this.dispatchTimeUpdate(this.engine.getCurrentTime());
    this.scheduleNextTimeSync();
  }

  private stopTimeSync(): void {
    this._timeSyncActive = false;
    if (this._timeSyncHandle === null) {
      return;
    }

    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._timeSyncHandle);
    } else {
      clearTimeout(this._timeSyncHandle);
    }
    this._timeSyncHandle = null;
  }

  private scheduleNextTimeSync(): void {
    if (!this._timeSyncActive) {
      return;
    }

    const tick = () => {
      if (!this._timeSyncActive) {
        return;
      }
      this.dispatchTimeUpdate(this.engine.getCurrentTime());
      this.scheduleNextTimeSync();
    };

    if (typeof requestAnimationFrame === 'function') {
      this._timeSyncHandle = requestAnimationFrame(() => tick());
    } else {
      this._timeSyncHandle = setTimeout(tick, 16) as unknown as number;
    }
  }
}
