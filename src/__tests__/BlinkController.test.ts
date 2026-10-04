import { describe, expect, it } from 'vitest';
import {
  createBlinkControlState,
  evaluateBlinkMultiplier,
  normalizeBlinkIntervalRangeMs,
} from '../engine/live2d/blinkController';

describe('BlinkController (Seam 1)', () => {
  describe('Backward compatibility', () => {
    it('behaves identically to constant interval when intervalRangeMs is omitted or zero', () => {
      const stateWithoutRange = createBlinkControlState(true, 4000, 0, 0);
      const stateWithZeroRange = createBlinkControlState(true, 4000, 0, 0, 0);

      // BLINK_DURATION = 0.3s (4000ms interval -> blink happens at [3.7s, 4.0s])
      // At t = 3.6s: eyes fully open (1.0)
      expect(evaluateBlinkMultiplier(3.6, stateWithoutRange)).toBe(1);
      expect(evaluateBlinkMultiplier(3.6, stateWithZeroRange)).toBe(1);

      // At t = 3.8s: eyes closing/closed (0 < val < 1 or 0)
      const multAt38 = evaluateBlinkMultiplier(3.8, stateWithoutRange);
      expect(multAt38).toBeLessThan(1);
      expect(evaluateBlinkMultiplier(3.8, stateWithZeroRange)).toBe(multAt38);

      // At t = 4.0s: eyes fully open again
      expect(evaluateBlinkMultiplier(4.0, stateWithoutRange)).toBe(1);
      expect(evaluateBlinkMultiplier(4.0, stateWithZeroRange)).toBe(1);
    });
  });

  describe('Random variation range bounds', () => {
    it('normalizes intervalRangeMs to non-negative numbers', () => {
      expect(normalizeBlinkIntervalRangeMs(500)).toBe(500);
      expect(normalizeBlinkIntervalRangeMs(0)).toBe(0);
      expect(normalizeBlinkIntervalRangeMs(-100)).toBe(0);
      expect(normalizeBlinkIntervalRangeMs(NaN as any)).toBe(0);
      expect(normalizeBlinkIntervalRangeMs(undefined as any)).toBe(0);
    });

    it('varies intervals strictly within [interval - range, interval + range]', () => {
      // 5s interval with 0.5s range -> each interval in [4.5s, 5.5s]
      const state = createBlinkControlState(true, 5000, 0, 0, 500);

      // Let's sample blinks across 100 seconds
      // A blink occurs when evaluateBlinkMultiplier drops below 1.
      // We detect the end of each blink (where multiplier returns to 1).
      const blinkEndTimes: number[] = [];
      let wasBlinking = false;
      const dt = 0.01; // 10ms sampling
      for (let t = 0; t <= 60; t = Number((t + dt).toFixed(4))) {
        const mult = evaluateBlinkMultiplier(t, state);
        const isBlinking = mult < 1;
        if (wasBlinking && !isBlinking) {
          blinkEndTimes.push(t);
        }
        wasBlinking = isBlinking;
      }

      expect(blinkEndTimes.length).toBeGreaterThanOrEqual(8);

      // Calculate the intervals between consecutive blink cycle completions
      let prevTime = 0;
      const observedIntervals: number[] = [];
      for (const endTime of blinkEndTimes) {
        const interval = endTime - prevTime;
        observedIntervals.push(interval);
        // Each interval must be within [4.5 - dt, 5.5 + dt] due to discrete sampling
        expect(interval).toBeGreaterThanOrEqual(4.5 - dt * 2);
        expect(interval).toBeLessThanOrEqual(5.5 + dt * 2);
        prevTime = endTime;
      }

      // Check that intervals actually vary (not all equal)
      const allEqual = observedIntervals.every(
        (val) => Math.abs(val - observedIntervals[0]) < 0.001,
      );
      expect(allEqual).toBe(false);
    });
  });

  describe('Seek and playback determinism', () => {
    it('produces identical multipliers when seeking directly vs playing sequentially', () => {
      const state = createBlinkControlState(true, 5000, 0, 0, 500);

      // Discrete seek times to test: various times including middle of blinks
      const sampleTimes = [
        0.5, 4.3, 4.7, 4.85, 4.95, 5.1, 9.2, 9.6, 9.75, 14.5, 23.456, 37.89,
      ];

      for (const t of sampleTimes) {
        // Direct seek: evaluate from scratch at time t
        const seekMultiplier = evaluateBlinkMultiplier(t, state);

        // Simulated sequential playback up to time t with state copy
        const playState = { ...state, sceneTimeSeconds: 0 };
        const step = 0.016; // 60fps
        let curT = 0;
        let lastPlayMultiplier = 1;
        while (curT < t) {
          const nextT = Math.min(t, curT + step);
          playState.sceneTimeSeconds = nextT;
          lastPlayMultiplier = evaluateBlinkMultiplier(nextT, playState);
          curT = nextT;
        }

        // Must be exactly identical (deterministic)
        expect(seekMultiplier).toBeCloseTo(lastPlayMultiplier, 5);
      }
    });

    it('remains deterministic when seeking back and forth in random order', () => {
      const state = createBlinkControlState(true, 4000, 0, 0, 800);
      const targetTime = 12.345;

      const firstEvaluation = evaluateBlinkMultiplier(targetTime, state);

      // Seek forward
      evaluateBlinkMultiplier(50.0, state);
      // Seek backwards
      evaluateBlinkMultiplier(2.0, state);
      // Seek back to target
      const secondEvaluation = evaluateBlinkMultiplier(targetTime, state);

      expect(secondEvaluation).toBe(firstEvaluation);
    });
  });
});
