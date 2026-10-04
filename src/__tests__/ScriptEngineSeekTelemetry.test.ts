/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScriptEngine from '../engine/ScriptEngine';
import { live2DManager } from '../engine/Live2DManager';
import { seekProfiler, type SeekPhaseReport } from '../engine/SeekProfiler';

function makeFakeTimeline() {
  return {
    kill: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    play: vi.fn(),
  };
}

describe('seekProfiler service', () => {
  beforeEach(() => {
    seekProfiler.reset();
    seekProfiler.setEnabled(false);
  });

  afterEach(() => {
    delete (window as any).__AEON_SEEK_PROFILER;
  });

  it('reports accumulated phase durations and total when enabled', () => {
    const nowSpy = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)   // startSeek
      .mockReturnValueOnce(100); // finishSeek
    seekProfiler.setEnabled(true);
    seekProfiler.startSeek({ time: 1.25, forceReconstruct: true });
    seekProfiler.addTime('model-load', 10);
    seekProfiler.addTime('snapshot-restore', 20);
    seekProfiler.addTime('forward-sim', 8);
    seekProfiler.addTime('motion-step', 5);
    seekProfiler.addTime('native-restore', 4);
    seekProfiler.addTime('state-sync', 30);
    seekProfiler.finishSeek(2);

    const report = seekProfiler.getLastReport();
    expect(report).not.toBeNull();
    expect(report!.time).toBe(1.25);
    expect(report!.forceReconstruct).toBe(true);
    expect(report!.characterCount).toBe(2);
    expect(report!.modelLoadMs).toBe(10);
    expect(report!.snapshotRestoreMs).toBe(20);
    expect(report!.forwardSimulateMs).toBe(8);
    expect(report!.motionStepMs).toBe(5);
    expect(report!.nativeRestoreMs).toBe(4);
    expect(report!.stateSyncMs).toBe(30);
    expect(report!.totalMs).toBe(100);
    // Top-level phases (model + snapshot + native + state) sum to 64, so the
    // remaining 36ms is reported as unattributed overhead.
    expect(report!.otherMs).toBe(36);
    nowSpy.mockRestore();
  });

  it('emits a report to listeners and the event bus is fired once', async () => {
    seekProfiler.setEnabled(true);
    const listener = vi.fn();
    seekProfiler.onReport(listener);
    const busEmit = vi.spyOn(await import('../api/events').then(m => m.eventBus), 'emit');

    seekProfiler.startSeek({ time: 0.5, forceReconstruct: false });
    seekProfiler.addTime('state-sync', 1);
    seekProfiler.finishSeek(1);

    expect(listener).toHaveBeenCalledTimes(1);
    const report = listener.mock.calls[0][0] as SeekPhaseReport;
    expect(report.stateSyncMs).toBe(1);
    expect(busEmit).toHaveBeenCalledWith('engine:seek:report', report);
    busEmit.mockRestore();
  });

  it('is a complete no-op when disabled', () => {
    seekProfiler.setEnabled(false);
    seekProfiler.startSeek({ time: 0, forceReconstruct: true });
    seekProfiler.addTime('model-load', 100);
    seekProfiler.finishSeek(1);
    expect(seekProfiler.getLastReport()).toBeNull();
  });

  it('honors window.__AEON_SEEK_PROFILER as a live override on the next seek', () => {
    // jsdom environment provides `window`.
    (window as any).__AEON_SEEK_PROFILER = false;
    seekProfiler.setEnabled(true);
    seekProfiler.startSeek({ time: 0, forceReconstruct: false });
    seekProfiler.addTime('model-load', 5);
    seekProfiler.finishSeek(1);
    expect(seekProfiler.getLastReport()).toBeNull();

    (window as any).__AEON_SEEK_PROFILER = true;
    seekProfiler.startSeek({ time: 0, forceReconstruct: false });
    seekProfiler.addTime('model-load', 5);
    seekProfiler.finishSeek(1);
    expect(seekProfiler.getLastReport()).not.toBeNull();
  });

  it('cancel discards the active profile without a report', () => {
    seekProfiler.setEnabled(true);
    seekProfiler.startSeek({ time: 0, forceReconstruct: true });
    seekProfiler.addTime('model-load', 10);
    seekProfiler.cancel();
    seekProfiler.finishSeek(1);
    expect(seekProfiler.getLastReport()).toBeNull();
  });

  it('collects cache-miss reasons (deduplicated by key) into the seek report', () => {
    seekProfiler.setEnabled(true);
    seekProfiler.startSeek({ time: 0.5, forceReconstruct: false });
    seekProfiler.addCacheMiss('wave', 'parts-layout-curves');
    seekProfiler.addCacheMiss('smile', 'not-cached');
    // Duplicate reports for the same motion key are collapsed.
    seekProfiler.addCacheMiss('wave', 'parts-layout-curves');
    seekProfiler.finishSeek(1);

    const report = seekProfiler.getLastReport();
    expect(report).not.toBeNull();
    expect(report!.cacheMissKeys).toEqual([
      'wave(parts-layout-curves)',
      'smile(not-cached)',
    ]);
  });
});

describe('ScriptEngine._doSeek telemetry wiring', () => {
  beforeEach(() => {
    seekProfiler.reset();
    seekProfiler.setEnabled(true);
  });

  afterEach(() => {
    seekProfiler.setEnabled(false);
  });

  it('tracks a forceReconstruct=false seek and reports a state-sync phase', async () => {
    const engine = new ScriptEngine();
    const timeline = makeFakeTimeline();
    (engine as any).masterTimeline = timeline;
    const syncAllStates = vi.spyOn(engine as any, 'syncAllStates').mockResolvedValue(undefined);
    const pauseForSeek = vi.spyOn(engine as any, 'pauseForSeek').mockImplementation(() => {});
    const computeStateAtTime = vi.spyOn(engine as any, 'computeStateAtTime')
      .mockReturnValue({ characters: new Map(), environmentLayers: new Map(), dialogue: {} });

    try {
      await engine.seek(1.25, false);
      // Scrub path: skipHardReset=true, isScrubbing=true (the legacy
      // freezeVisibleMotionDuringSeek argument was removed with the
      // forward-simulation path).
      expect(syncAllStates).toHaveBeenCalledWith(1.25, true, true);
      const report = seekProfiler.getLastReport();
      expect(report).not.toBeNull();
      expect(report!.time).toBe(1.25);
      expect(report!.forceReconstruct).toBe(false);
      expect(report!.stateSyncMs).toBeGreaterThanOrEqual(0);
      expect(report!.modelLoadMs).toBe(0);
    } finally {
      pauseForSeek.mockRestore();
      syncAllStates.mockRestore();
      computeStateAtTime.mockRestore();
    }
  });

  it('tracks model-load and state-sync for a forceReconstruct=true seek with no characters', async () => {
    const engine = new ScriptEngine();
    const timeline = makeFakeTimeline();
    (engine as any).masterTimeline = timeline;
    const syncAllStates = vi.spyOn(engine as any, 'syncAllStates').mockResolvedValue(undefined);
    const pauseForSeek = vi.spyOn(engine as any, 'pauseForSeek').mockImplementation(() => {});
    const computeStateAtTime = vi.spyOn(engine as any, 'computeStateAtTime')
      .mockReturnValue({ characters: new Map(), environmentLayers: new Map(), dialogue: {} });
    const clearAllPendingMotions = vi.spyOn(live2DManager, 'clearAllPendingMotions').mockImplementation(() => {});

    try {
      await engine.seek(2.5, true);
      const report = seekProfiler.getLastReport();
      expect(report).not.toBeNull();
      expect(report!.forceReconstruct).toBe(true);
      expect(report!.modelLoadMs).toBeGreaterThanOrEqual(0);
      expect(report!.stateSyncMs).toBeGreaterThanOrEqual(0);
      expect(clearAllPendingMotions).toHaveBeenCalled();
    } finally {
      clearAllPendingMotions.mockRestore();
      pauseForSeek.mockRestore();
      syncAllStates.mockRestore();
      computeStateAtTime.mockRestore();
    }
  });

  it('cancels telemetry when a stale forceReconstruct seek returns early', async () => {
    const engine = new ScriptEngine();
    const timeline = makeFakeTimeline();
    (engine as any).masterTimeline = timeline;
    const syncAllStates = vi.spyOn(engine as any, 'syncAllStates').mockResolvedValue(undefined);
    const pauseForSeek = vi.spyOn(engine as any, 'pauseForSeek').mockImplementation(() => {});
    const computeStateAtTime = vi.spyOn(engine as any, 'computeStateAtTime')
      .mockReturnValue({ characters: new Map(), environmentLayers: new Map(), dialogue: {} });
    // Force the first _doSeek to become stale after model load by bumping the
    // version from inside addCharacter (we simulate an empty desired set, so
    // bump here by wrapping syncAllStates -> not needed: bump before second
    // phase by changing _seekVersion during the awaited syncAllStates).
    syncAllStates.mockImplementation(async () => {
      // A newer request supersedes this seek while it is still reconstructing.
      (engine as any)._seekVersion += 1;
      await Promise.resolve();
    });

    try {
      await engine.seek(1, true);
      // The stale _doSeek exits before finishSeek; the queue loop should not
      // produce a report from that abandoned attempt.
      expect(seekProfiler.getLastReport()).toBeNull();
    } finally {
      syncAllStates.mockRestore();
      pauseForSeek.mockRestore();
      computeStateAtTime.mockRestore();
    }
  });
});