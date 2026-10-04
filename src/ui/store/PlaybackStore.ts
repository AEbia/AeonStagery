import type { IPlaybackStore } from '../../api/interfaces';

export class PlaybackStore implements IPlaybackStore {
  private _playing: boolean = false;
  private _duration: number = 0;
  private _engineStatus: string = '';
  readonly _listeners: Set<() => void> = new Set();

  get playing(): boolean { return this._playing; }
  get duration(): number { return this._duration; }
  get engineStatus(): string { return this._engineStatus; }

  private _notify(): void {
    this._listeners.forEach(fn => fn());
  }

  _setPlaying(v: boolean): void {
    if (this._playing === v) return;
    this._playing = v;
    this._notify();
  }

  _setDuration(d: number): void {
    if (this._duration === d) return;
    this._duration = d;
    this._notify();
  }

  _setEngineStatus(s: string): void {
    if (this._engineStatus === s) return;
    this._engineStatus = s;
    this._notify();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  setPlaying(v: boolean): void { this._setPlaying(v); }
  setDuration(d: number): void { this._setDuration(d); }
  setEngineStatus(s: string): void { this._setEngineStatus(s); }
}
