/**
 * PlaybackAdapter tests
 *
 * The adapter bridges UI play/pause/seek/loop/speed intents to the engine,
 * while keeping PlaybackStore in sync.  Time subscriptions use a
 * fine-grained push model — engine bridge calls dispatchTimeUpdate(),
 * adapter fans out to all registered callbacks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlaybackAdapter } from '../api/adapters/PlaybackAdapter';
import { PlaybackStore } from '../ui/store/PlaybackStore';

// ── Helpers ──────────────────────────────────────────────────────

interface MockEngine {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  isPlaying: ReturnType<typeof vi.fn>;
  onPlayingChange: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
  setLoop: ReturnType<typeof vi.fn>;
  setLoopEnabled: ReturnType<typeof vi.fn>;
  setSpeed: ReturnType<typeof vi.fn>;
  getCurrentTime: ReturnType<typeof vi.fn>;
}

function createMockEngine(): MockEngine {
  let playing = false;
  const listeners = new Set<(playing: boolean) => void>();
  return {
    play: vi.fn(() => {
      playing = true;
      listeners.forEach(listener => listener(playing));
    }),
    pause: vi.fn(() => {
      playing = false;
      listeners.forEach(listener => listener(playing));
    }),
    isPlaying: vi.fn(() => playing),
    onPlayingChange: vi.fn((callback: (playing: boolean) => void) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    }),
    seek: vi.fn().mockResolvedValue(undefined),
    setLoop: vi.fn(),
    setLoopEnabled: vi.fn(),
    setSpeed: vi.fn(),
    getCurrentTime: vi.fn().mockReturnValue(0),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('PlaybackAdapter', () => {
  let store: PlaybackStore;
  let engine: MockEngine;
  let adapter: PlaybackAdapter;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

  beforeEach(() => {
    store = new PlaybackStore();
    engine = createMockEngine();
    adapter = new PlaybackAdapter(store, engine as any);
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  });

  afterEach(() => {
    adapter.dispose();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame as any;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame as any;
  });

  it('constructor requires playbackStore and engine', () => {
    expect(adapter).toBeDefined();
    expect(() => new PlaybackAdapter(store, engine as any)).not.toThrow();
  });

  // ── play() ────────────────────────────────────────────────────

  describe('play()', () => {
    it('sets store.playing to true', () => {
      adapter.play();
      expect(store.playing).toBe(true);
    });

    it('calls engine.play()', () => {
      adapter.play();
      expect(engine.play).toHaveBeenCalledTimes(1);
    });

    it('play() multiple times calls engine.play() each time', () => {
      adapter.play();
      adapter.play();
      expect(engine.play).toHaveBeenCalledTimes(2);
      expect(store.playing).toBe(true);
    });

    it('restarting play does not leave multiple animation loops alive', () => {
      let nextHandle = 0;
      globalThis.requestAnimationFrame = vi.fn(() => (++nextHandle)) as any;
      globalThis.cancelAnimationFrame = vi.fn();

      adapter.play();
      adapter.play();

      expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(globalThis.cancelAnimationFrame).not.toHaveBeenCalled();
    });

    it('starts pushing live time updates while playing', () => {
      let frameCallback: FrameRequestCallback | null = null;
      globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
        frameCallback = cb;
        return 1;
      }) as any;
      globalThis.cancelAnimationFrame = vi.fn();

      engine.getCurrentTime
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0.5);

      const cb = vi.fn();
      adapter.subscribeTime(cb);

      adapter.play();
      if (frameCallback) {
        const runFrame = frameCallback as FrameRequestCallback;
        runFrame(16);
      }

      expect(cb).toHaveBeenCalledWith(0);
      expect(cb).toHaveBeenCalledWith(0.5);
    });
  });

  // ── pause() ───────────────────────────────────────────────────

  describe('pause()', () => {
    it('sets store.playing to false', () => {
      store._setPlaying(true);
      adapter.pause();
      expect(store.playing).toBe(false);
    });

    it('calls engine.pause()', () => {
      adapter.pause();
      expect(engine.pause).toHaveBeenCalledTimes(1);
    });

    it('pause() when already paused is idempotent for the store', () => {
      adapter.pause();
      expect(store.playing).toBe(false);

      adapter.pause();
      expect(store.playing).toBe(false);
      expect(engine.pause).toHaveBeenCalledTimes(2);
    });
  });

  // ── seek() ────────────────────────────────────────────────────

  describe('seek()', () => {
    it('calls engine.seek with the requested time', () => {
      adapter.seek(5.0);
      expect(engine.seek).toHaveBeenCalledWith(5.0);
    });

    it('returns a Promise (mirrors engine.seek return)', () => {
      const result = adapter.seek(10.0);
      expect(result).toBeInstanceOf(Promise);
    });

    it('resolves when engine.seek resolves', async () => {
      await adapter.seek(3.0);
      expect(engine.seek).toHaveBeenCalledWith(3.0);
    });

    it('notifies subscribers with the requested and final engine time when seeking', async () => {
      engine.getCurrentTime.mockReturnValue(3.25);
      const cb = vi.fn();
      adapter.subscribeTime(cb);

      await adapter.seek(3.0);

      expect(cb).toHaveBeenCalledWith(3.0);
      expect(cb).toHaveBeenCalledWith(3.25);
    });

    it('does not dispatch a stale final time when an older seek finishes after a newer seek', async () => {
      let resolveFirst!: () => void;
      let resolveSecond!: () => void;
      engine.seek
        .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
        .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSecond = resolve; }));
      engine.getCurrentTime.mockReturnValue(2);
      const cb = vi.fn();
      adapter.subscribeTime(cb);

      const first = adapter.seek(1);
      const second = adapter.seek(2);
      resolveSecond();
      await second;
      resolveFirst();
      await first;

      expect(cb.mock.calls.map(([time]) => time)).toEqual([1, 2, 2]);
    });

    it('seek(0) seeks to the timeline start', () => {
      adapter.seek(0);
      expect(engine.seek).toHaveBeenCalledWith(0);
    });

    it('notifies time subscribers with the seek target time', () => {
      const cb = vi.fn();
      adapter.subscribeTime(cb);
      adapter.seek(7.5);
      expect(cb).toHaveBeenCalledWith(7.5);
    });
  });

  // ── setLoop() ─────────────────────────────────────────────────

  describe('setLoop()', () => {
    it('calls engine.setLoop with start and end', () => {
      adapter.setLoop(1, 10);
      expect(engine.setLoop).toHaveBeenCalledWith(1, 10);
    });

    it('passes different loop ranges to engine', () => {
      adapter.setLoop(5, 20);
      expect(engine.setLoop).toHaveBeenCalledWith(5, 20);
    });

    it('passes zero-based ranges', () => {
      adapter.setLoop(0, 30);
      expect(engine.setLoop).toHaveBeenCalledWith(0, 30);
    });
  });

  // ── setLoopEnabled() ──────────────────────────────────────────

  describe('setLoopEnabled()', () => {
    it('calls engine.setLoopEnabled(true)', () => {
      adapter.setLoopEnabled(true);
      expect(engine.setLoopEnabled).toHaveBeenCalledWith(true);
    });

    it('calls engine.setLoopEnabled(false)', () => {
      adapter.setLoopEnabled(false);
      expect(engine.setLoopEnabled).toHaveBeenCalledWith(false);
    });

    it('toggling on then off calls engine both times', () => {
      adapter.setLoopEnabled(true);
      adapter.setLoopEnabled(false);

      expect(engine.setLoopEnabled).toHaveBeenCalledTimes(2);
      expect(engine.setLoopEnabled).toHaveBeenNthCalledWith(1, true);
      expect(engine.setLoopEnabled).toHaveBeenNthCalledWith(2, false);
    });
  });

  // ── setSpeed() ────────────────────────────────────────────────

  describe('setSpeed()', () => {
    it('calls engine.setSpeed with the given value', () => {
      adapter.setSpeed(2.0);
      expect(engine.setSpeed).toHaveBeenCalledWith(2.0);
    });

    it('passes fractional speed values', () => {
      adapter.setSpeed(0.5);
      expect(engine.setSpeed).toHaveBeenCalledWith(0.5);
    });

    it('passes slow-motion speed', () => {
      adapter.setSpeed(0.25);
      expect(engine.setSpeed).toHaveBeenCalledWith(0.25);
    });
  });

  // ── dispatchTimeUpdate() ──────────────────────────────────────

  describe('dispatchTimeUpdate()', () => {
    it('fans out time to all registered callbacks', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      adapter.subscribeTime(cb1);
      adapter.subscribeTime(cb2);

      adapter.dispatchTimeUpdate(1.5);
      expect(cb1).toHaveBeenCalledWith(1.5);
      expect(cb2).toHaveBeenCalledWith(1.5);
    });

    it('does not throw when no callbacks are registered', () => {
      expect(() => adapter.dispatchTimeUpdate(5.0)).not.toThrow();
    });
  });

  // ── subscribeTime() ───────────────────────────────────────────

  describe('subscribeTime()', () => {
    it('returns an unsubscribe function', () => {
      const unsubscribe = adapter.subscribeTime(vi.fn());
      expect(typeof unsubscribe).toBe('function');
    });

    it('unsubscribe removes the callback — it no longer receives updates', () => {
      const cb = vi.fn();
      const unsubscribe = adapter.subscribeTime(cb);

      unsubscribe();
      adapter.dispatchTimeUpdate(3.0);

      expect(cb).not.toHaveBeenCalled();
    });

    it('unsubscribe is idempotent (does not throw on second call)', () => {
      const cb = vi.fn();
      const unsubscribe = adapter.subscribeTime(cb);

      unsubscribe();
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  // ── multiple subscribeTime callbacks ──────────────────────────

  describe('multiple subscribeTime callbacks', () => {
    it('registers each callback independently', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      adapter.subscribeTime(cb1);
      adapter.subscribeTime(cb2);

      adapter.dispatchTimeUpdate(2.0);
      expect(cb1).toHaveBeenCalledWith(2.0);
      expect(cb2).toHaveBeenCalledWith(2.0);
    });

    it('unsubscribing one callback does not affect the other', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      adapter.subscribeTime(cb1);
      const unsub2 = adapter.subscribeTime(cb2);

      unsub2();

      adapter.dispatchTimeUpdate(2.0);
      expect(cb1).toHaveBeenCalledWith(2.0);
      expect(cb2).not.toHaveBeenCalled();
    });

    it('unsubscribed callback does not receive further updates', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      adapter.subscribeTime(cb1);
      const unsub2 = adapter.subscribeTime(cb2);

      unsub2();

      adapter.dispatchTimeUpdate(2.0);
      expect(cb1).toHaveBeenCalledWith(2.0);
      expect(cb2).not.toHaveBeenCalled();
    });
  });

  // ── dispose() ─────────────────────────────────────────────────

  describe('dispose()', () => {
    it('removes all time subscribers — no callbacks fire after dispose', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      adapter.subscribeTime(cb1);
      adapter.subscribeTime(cb2);

      adapter.dispose();

      adapter.dispatchTimeUpdate(3.0);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it('does not throw when calling dispose with no subscribers', () => {
      expect(() => adapter.dispose()).not.toThrow();
    });

    it('dispose then subscribeTime still works (clean start)', () => {
      const oldCb = vi.fn();
      adapter.subscribeTime(oldCb);
      adapter.dispose();

      const newCb = vi.fn();
      adapter.subscribeTime(newCb);

      adapter.dispatchTimeUpdate(1.0);
      expect(oldCb).not.toHaveBeenCalled();
      expect(newCb).toHaveBeenCalledWith(1.0);
    });
  });
});
