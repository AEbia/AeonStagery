/**
 * AeonStagery — Seek Profiler
 *
 * Lightweight, testable instrumentation for `ScriptEngine._doSeek`.
 *
 * It measures the phases that dominate seek latency:
 *  - model-load       : asset path resolution + Live2D model (re)creation
 *  - snapshot-restore : SnapshotStore restore + motion-queue prefill
 *  - forward-sim      : legacy Cubism 2 snapshot->target stepping loop
 *  - motion-step      : Cubism 2 motion-offset fast-forward (50ms/16ms SDK steps)
 *  - native-restore   : untitled-pixi-live2d-engine-cubism `restoreSeekState` loop
 *  - state-sync       : timeline/environment/expression/proxy reconciliation
 *
 * `forwardSimulateMs` and `motionStepMs` are deliberately sub-measurements and
 * may overlap other phases (motion stepping can occur both inside
 * `simulateForward` and while starting a motion during state sync). The
 * top-level, non-overlapping timeline is:
 *
 *   model-load -> snapshot-restore -> native-restore -> state-sync -> other
 *
 * The profiler is disabled by default and is a no-op unless `setEnabled(true)`
 * is called, so normal playback/seek and existing tests pay nothing.
 */

import { eventBus } from '../api/events';
import { getLogger } from './Logger';

export interface SeekPhaseReport {
  readonly time: number;
  readonly forceReconstruct: boolean;
  readonly characterCount: number;
  readonly totalMs: number;
  /** Model path resolution + addCharacter / removeCharacter. */
  readonly modelLoadMs: number;
  /** Snapshot apply + motion-queue prefill + post-apply flush. */
  readonly snapshotRestoreMs: number;
  /** Legacy Cubism 2 `simulateForward` (nested sub-measurement). */
  readonly forwardSimulateMs: number;
  /** Cubism 2 SDK stepping fast-forward (nested sub-measurement). */
  readonly motionStepMs: number;
  /** Official Cubism Web `restoreSeekState` loop. */
  readonly nativeRestoreMs: number;
  /** Character/environment/expression/proxy reconciliation after restore. */
  readonly stateSyncMs: number;
  /**
   * Resource motions that still fell back to the SDK path during this seek,
   * formatted as `motionKey(reason)` with reasons from the motion curve cache
   * (e.g. `parts-layout-curves`, `sampling-failed`, `not-cached`). Deduplicated
   * per motion key. Lets a non-zero `motionStepMs` be explained.
   */
  readonly cacheMissKeys: readonly string[];
  /** Remainder not attributed to any top-level phase. */
  readonly otherMs: number;
}

export type SeekPhaseName = 'model-load' | 'snapshot-restore' | 'forward-sim' | 'motion-step' | 'native-restore' | 'state-sync';

const TOP_LEVEL_PHASES: readonly SeekPhaseName[] = [
  'model-load',
  'snapshot-restore',
  'native-restore',
  'state-sync',
];

interface ActiveSeekProfile {
  readonly time: number;
  readonly forceReconstruct: boolean;
  startedAt: number;
  durations: Record<SeekPhaseName, number>;
  readonly cacheMisses: Array<{ key: string; code: string }>;
}

class SeekProfiler {
  private logger = getLogger('SeekProfiler');
  private enabled = false;
  private active: ActiveSeekProfile | null = null;
  private lastReport: SeekPhaseReport | null = null;
  private readonly listeners = new Set<(report: SeekPhaseReport) => void>();

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.active = null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  startSeek(input: { time: number; forceReconstruct: boolean }): void {
    // Honor a live runtime toggle: setting `window.__AEON_SEEK_PROFILER` to a
    // boolean takes effect on the next seek. Dev builds enable profiling by
    // default (see main.tsx); packaged builds can profile on demand with
    // `window.__AEON_SEEK_PROFILER = true` from the console.
    this.applyWindowOverride();
    if (!this.enabled) return;
    // A superseding seek cancels any straggler profile, mirroring the seek
    // coalescing behavior (one seek may replace another before it finishes).
    this.active = {
      time: input.time,
      forceReconstruct: input.forceReconstruct,
      startedAt: performance.now(),
      durations: {
        'model-load': 0,
        'snapshot-restore': 0,
        'forward-sim': 0,
        'motion-step': 0,
        'native-restore': 0,
        'state-sync': 0,
      },
      cacheMisses: [],
    };
  }

  /**
   * Add elapsed milliseconds to a phase. Safe to call when profiling is off or
   * after cancellation; never throws.
   */
  addTime(phase: SeekPhaseName, milliseconds: number): void {
    if (!this.enabled || !this.active) return;
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.active.durations[phase] += milliseconds;
  }

  /**
   * Record that a resource motion fell back to the SDK path during this seek,
   * with the cache miss-reason code (see `SeekPhaseReport.cacheMissKeys`).
   * Safe to call when profiling is off or after cancellation; deduplicated by
   * motion key so repeated seeks/characters do not bloat the report.
   */
  addCacheMiss(motionKey: string, reasonCode: string): void {
    if (!this.enabled || !this.active || !motionKey) return;
    if (!this.active.cacheMisses.some((miss) => miss.key === motionKey)) {
      this.active.cacheMisses.push({ key: motionKey, code: reasonCode });
    }
  }

  /**
   * Honor a live runtime toggle: setting `window.__AEON_SEEK_PROFILER` to a
   * boolean takes effect on the next seek. Dev builds enable profiling by
   * default (see main.tsx); packaged builds can profile on demand with
   * `window.__AEON_SEEK_PROFILER = true` from the console.
   */
  private applyWindowOverride(): void {
    if (typeof window === 'undefined') return;
    const override = (window as any).__AEON_SEEK_PROFILER;
    if (typeof override === 'boolean') this.enabled = override;
  }

  /** Cancel the active profile without emitting a report (stale seek path). */
  cancel(): void {
    if (!this.enabled) return;
    this.active = null;
  }

  /**
   * Finish the active profile and emit a report to listeners and the event
   * bus. Character count is supplied by the caller because it is known only at
   * completion time.
   */
  finishSeek(characterCount: number): void {
    if (!this.enabled || !this.active) return;
    const active = this.active;
    this.active = null;
    const now = performance.now();
    const totalMs = Math.max(0, now - active.startedAt);

    const modelLoadMs = active.durations['model-load'];
    const snapshotRestoreMs = active.durations['snapshot-restore'];
    const forwardSimulateMs = active.durations['forward-sim'];
    const motionStepMs = active.durations['motion-step'];
    const nativeRestoreMs = active.durations['native-restore'];
    const stateSyncMs = active.durations['state-sync'];

    const topLevelSum = TOP_LEVEL_PHASES.reduce((sum, phase) => sum + active.durations[phase], 0);
    const otherMs = Math.max(0, totalMs - topLevelSum);

    const report: SeekPhaseReport = {
      time: active.time,
      forceReconstruct: active.forceReconstruct,
      characterCount,
      totalMs,
      modelLoadMs,
      snapshotRestoreMs,
      forwardSimulateMs,
      motionStepMs,
      nativeRestoreMs,
      stateSyncMs,
      cacheMissKeys: active.cacheMisses.map((miss) => `${miss.key}(${miss.code})`),
      otherMs,
    };

    this.lastReport = report;
    // Debug level so it is visible in the dev console by default (dev default
    // log level is DEBUG; TRACE would be filtered). The event bus emission
    // keeps the report available to diagnostics/UI listeners.
    this.logger.debug(
      `seek report @ ${report.time.toFixed(3)}s force=${report.forceReconstruct} chars=${characterCount} total=${totalMs.toFixed(1)}ms`
      + ` model=${modelLoadMs.toFixed(1)} snap=${snapshotRestoreMs.toFixed(1)} forward=${forwardSimulateMs.toFixed(1)}`
      + ` motionStep=${motionStepMs.toFixed(1)} native=${nativeRestoreMs.toFixed(1)} state=${stateSyncMs.toFixed(1)} other=${otherMs.toFixed(1)}`,
    );
    void eventBus.emit('engine:seek:report', report);
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(report);
      } catch {
        // Telemetry listeners must never break the seek path.
      }
    }
  }

  getLastReport(): SeekPhaseReport | null {
    return this.lastReport;
  }

  /** Test helper: clear the active profile, last report, and listeners. */
  reset(): void {
    this.active = null;
    this.lastReport = null;
    this.listeners.clear();
  }

  onReport(listener: (report: SeekPhaseReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const seekProfiler = new SeekProfiler();