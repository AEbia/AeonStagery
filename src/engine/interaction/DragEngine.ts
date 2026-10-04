import { resolveTimelineSnap } from '../../services/timeline-interaction/TimelineSnapResolver';

export interface SnapConfig {
  /** Grid step in value units. 0 = no grid snapping. */
  gridStep: number;
  /** Max pixel distance for magnetic snap to engage. */
  thresholdPx: number;
  /** Dynamic snap targets (playhead, sibling edges). Called each update(). */
  getSnapTargets?: () => number[];
  /** Pixels per value unit — used to convert thresholdPx to value-space. Default 50. */
  pixelsPerUnit?: number;
}

export class DragEngine {
  private _keys: Record<string, number> | null = null;
  private _config: SnapConfig | null = null;
  private _isDragging = false;
  private _snappedDeltas: Record<string, number> = {};
  onChange = new Set<() => void>();

  get isDragging(): boolean {
    return this._isDragging;
  }

  beginDrag(keys: Record<string, number>, config: SnapConfig): void {
    if (this._isDragging) throw new Error('Drag already in progress');
    this._keys = { ...keys };
    this._config = config;
    this._isDragging = true;
    this._snappedDeltas = {};
    for (const key of Object.keys(keys)) {
      this._snappedDeltas[key] = 0;
    }
    this._notify();
  }

  update(rawDeltas: Record<string, number>, config?: SnapConfig): Record<string, number> {
    if (!this._isDragging || !this._keys) {
      throw new Error('No active drag');
    }

    const activeConfig = config ?? this._config;
    if (!activeConfig) return rawDeltas;

    const pps = activeConfig.pixelsPerUnit ?? 50;

    const result: Record<string, number> = {};

    for (const key of Object.keys(this._keys)) {
      const rawDelta = rawDeltas[key] ?? 0;
      const initial = this._keys[key];
      const snap = resolveTimelineSnap({
        initialValue: initial,
        rawDelta,
        gridStep: activeConfig.gridStep,
        thresholdPx: activeConfig.thresholdPx,
        pixelsPerUnit: pps,
        targets: activeConfig.getSnapTargets?.(),
      });

      result[key] = snap.delta;
    }

    this._snappedDeltas = { ...result };
    return result;
  }

  commit(): Record<string, number> {
    if (!this._isDragging) throw new Error('No active drag');
    const deltas = { ...this._snappedDeltas };
    this._keys = null;
    this._config = null;
    this._isDragging = false;
    this._notify();
    return deltas;
  }

  cancel(): void {
    this._keys = null;
    this._config = null;
    this._isDragging = false;
    this._notify();
  }

  private _notify(): void {
    this.onChange.forEach(fn => fn());
  }
}
