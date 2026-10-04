/**
 * AeonStagery — Snapshot Store
 *
 * Unified, time-ordered storage for Live2D model snapshots.
 * Serves both real-time playback snapshots (from ScriptEngine) and
 * pre-baked snapshots (from BakeEngine / PreBakeDaemon).
 *
 * Key design:
 * - Binary-search insert for O(log n) ordered insertion
 * - Deduplication within a configurable tolerance (default 0.01s)
 * - findBefore(time) returns the nearest snapshot at or before `time`
 *   with NO search window limit — the caller forward-simulates the delta
 * - mergeFrom() accepts external snapshot batches without duplicating
 * - getGaps() identifies uncovered time ranges for incremental baking
 * - Capacity-limited with automatic eviction of oldest entries
 */

import type { ModelSnapshot } from './Live2DConfig';
import { getLogger } from './Logger';
import { settingsManager } from '../ui/SettingsStore';

export interface Snapshot {
  time: number;
  models: Map<string, ModelSnapshot>;
}

function hasAnyNonZero(values: ArrayLike<number> | null | undefined): boolean {
  if (!values) return false;
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== 0) return true;
  }
  return false;
}

function isPollutedActiveMotionSnapshot(snapshot: ModelSnapshot): boolean {
  return !!snapshot.motion && !!snapshot.opacities && !hasAnyNonZero(snapshot.params);
}

export class SnapshotStore {
  private logger = getLogger('SnapshotStore');
  private store: Snapshot[] = [];

  /** Tolerance for deduplication (seconds). Snapshots closer than this are merged. */
  private readonly DEDUP_TOLERANCE = 0.01;

  // ── Query ──────────────────────────────────────────────────────────────

  /** Return the snapshot with the largest time <= `time`, or null. */
  findBefore(time: number): Snapshot | null {
    if (this.store.length === 0) return null;

    // Binary search for the rightmost entry with time <= target
    let lo = 0;
    let hi = this.store.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.store[mid].time <= time) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return result >= 0 ? this.store[result] : null;
  }

  /** Check if a snapshot exists within `tolerance` seconds of `time`. */
  hasAt(time: number, tolerance: number = 0.05): boolean {
    if (this.store.length === 0) return false;
    const snap = this.findBefore(time + tolerance);
    return snap !== null && Math.abs(snap.time - time) < tolerance;
  }

  /** Return all snapshots in the [start, end] range. */
  getRange(start: number, end: number): Snapshot[] {
    if (this.store.length === 0) return [];

    // Find first index >= start
    let lo = 0, hi = this.store.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.store[mid].time < start) lo = mid + 1;
      else hi = mid;
    }

    const result: Snapshot[] = [];
    for (let i = lo; i < this.store.length && this.store[i].time <= end; i++) {
      result.push(this.store[i]);
    }
    return result;
  }

  /**
   * Find time gaps in the [start, end] range where the distance between
   * consecutive snapshots exceeds `maxGap`.
   * Returns an array of {from, to} intervals that need filling.
   */
  getGaps(start: number, end: number, maxGap: number): { from: number; to: number }[] {
    const gaps: { from: number; to: number }[] = [];
    const rangeSnaps = this.getRange(start, end);

    if (rangeSnaps.length === 0) {
      // No coverage at all
      gaps.push({ from: start, to: end });
      return gaps;
    }

    // Gap before first snapshot
    if (rangeSnaps[0].time - start > maxGap) {
      gaps.push({ from: start, to: rangeSnaps[0].time });
    }

    // Gaps between consecutive snapshots
    for (let i = 1; i < rangeSnaps.length; i++) {
      const delta = rangeSnaps[i].time - rangeSnaps[i - 1].time;
      if (delta > maxGap) {
        gaps.push({ from: rangeSnaps[i - 1].time, to: rangeSnaps[i].time });
      }
    }

    // Gap after last snapshot
    const lastTime = rangeSnaps[rangeSnaps.length - 1].time;
    if (end - lastTime > maxGap) {
      gaps.push({ from: lastTime, to: end });
    }

    return gaps;
  }

  // ── Mutation ─────────────────────────────────────────────────────────

  /** Insert a single snapshot, deduplicating if one exists at the same time. */
  insert(time: number, models: Map<string, ModelSnapshot>): void {
    const cleanModels = this.filterPollutedModels(time, models);
    if (cleanModels.size === 0) return;

    const maxCount = settingsManager.get('snapshotMaxCount');
    const snap: Snapshot = { time, models: cleanModels };

    // Check for existing snapshot at this time
    const existingIdx = this.findIndexAt(time);
    if (existingIdx !== -1) {
      this.store[existingIdx] = snap;
      return;
    }

    // Binary search insert to maintain ascending order
    let lo = 0, hi = this.store.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.store[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    this.store.splice(lo, 0, snap);

    // Evict oldest if over capacity
    while (this.store.length > maxCount) {
      this.store.shift();
    }
  }

  /**
   * Merge an array of snapshots from an external source (e.g. BakeEngine).
   * Existing snapshots at the same times are overwritten.
   * This is the primary interface for integrating pre-baked snapshots.
   */
  mergeFrom(snapshots: Snapshot[]): number {
    if (snapshots.length === 0) return 0;

    let merged = 0;
    for (const snap of snapshots) {
      const before = this.size;
      this.insert(snap.time, snap.models);
      if (this.size !== before || this.findBefore(snap.time)?.time === snap.time) {
        merged++;
      }
    }

    this.logger.trace(
      `Merged ${merged} snapshots. Store size: ${this.store.length}`,
      'color: #0af;',
    );
    return merged;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Clear all snapshots. */
  clear(): void {
    this.store = [];
  }

  /** Invalidate (discard) all snapshots strictly at or after the given time. */
  invalidateAfter(time: number): void {
    if (this.store.length === 0) return;
    
    // Find the first index where time >= target time
    let lo = 0, hi = this.store.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.store[mid].time < time) lo = mid + 1;
      else hi = mid;
    }

    if (lo < this.store.length) {
      const removed = this.store.length - lo;
      this.store.splice(lo);
      this.logger.trace(`Invalidated ${removed} snapshots after ${time.toFixed(3)}s. Remaining: ${this.store.length}`, 'color: #f00;');
    }
  }

  /** Get total snapshot count. */
  get size(): number {
    return this.store.length;
  }

  /** Get the time range covered. */
  get timeRange(): { min: number; max: number } | null {
    if (this.store.length === 0) return null;
    return {
      min: this.store[0].time,
      max: this.store[this.store.length - 1].time,
    };
  }

  /** Debug: return the raw store for logging. */
  _debugGetStore(): readonly Snapshot[] {
    return this.store;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  /** Find an existing snapshot within DEDUP_TOLERANCE of `time`. Returns index or -1. */
  private findIndexAt(time: number): number {
    // Binary search to find approximate position, then linear scan nearby
    let lo = 0, hi = this.store.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.store[mid].time < time - this.DEDUP_TOLERANCE) lo = mid + 1;
      else hi = mid;
    }

    // Check a small window around the insertion point
    for (let i = Math.max(0, lo - 1); i < Math.min(this.store.length, lo + 2); i++) {
      if (Math.abs(this.store[i].time - time) < this.DEDUP_TOLERANCE) {
        return i;
      }
    }
    return -1;
  }

  private filterPollutedModels(time: number, models: Map<string, ModelSnapshot>): Map<string, ModelSnapshot> {
    let cleanModels: Map<string, ModelSnapshot> | null = null;

    for (const [id, modelSnap] of models) {
      if (!isPollutedActiveMotionSnapshot(modelSnap)) {
        if (cleanModels) cleanModels.set(id, modelSnap);
        continue;
      }

      if (!cleanModels) cleanModels = new Map(models);
      cleanModels.delete(id);
      this.logger.trace(
        `Skipped polluted active-motion snapshot for "${id}" at ${time.toFixed(3)}s.`,
        'color: #f90;',
      );
    }

    return cleanModels ?? models;
  }
}
