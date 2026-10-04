import { describe, expect, it } from 'vitest';
import type { AiRhythmPace } from '../api/types/ai-authoring';
import {
  DEFAULT_DIALOGUE_DURATION_OPTIONS,
  PACE_GAP,
  PACE_MULTIPLIER,
  PACE_PAUSE_DURATION,
  TRANSITION_DURATIONS,
  estimateDialogueDuration,
  estimateDialogueDurationByReadingSpeed,
  resolveDialogueDuration,
} from '../services/pacing/pacing';

describe('pacing module', () => {
  describe('pace tier tables', () => {
    it('keeps the gap per pace tier', () => {
      expect(PACE_GAP).toEqual({
        snap: 0.25,
        normal: 0.5,
        slow: 0.8,
        hold: 1.2,
      });
    });

    it('keeps the duration multiplier per pace tier with normal as identity', () => {
      expect(PACE_MULTIPLIER).toEqual({
        snap: 0.82,
        normal: 1,
        slow: 1.25,
        hold: 1.5,
      });
      expect(PACE_MULTIPLIER.normal).toBe(1);
    });

    it('keeps the pause duration per pace tier', () => {
      expect(PACE_PAUSE_DURATION).toEqual({
        snap: 0.4,
        normal: 0.8,
        slow: 1.3,
        hold: 2.0,
      });
    });
  });

  describe('transition durations', () => {
    it('keeps the fixed WebGAL animation durations in seconds', () => {
      expect(TRANSITION_DURATIONS).toEqual({
        backgroundChange: 1.0,
        figureEnter: 0.3,
        figureExit: 0.45,
        cameraFocus: 0.5,
        setTransform: 0.5,
      });
    });
  });

  describe('estimateDialogueDuration (pace-tier estimate)', () => {
    const text = '我想把这句话说清楚。';

    it('estimates from compact character length at normal pace', () => {
      expect(estimateDialogueDuration(text, 'normal')).toBe(2.2);
    });

    it('scales the estimate by the pace multiplier', () => {
      expect(estimateDialogueDuration(text, 'snap')).toBe(1.8);
      expect(estimateDialogueDuration(text, 'slow')).toBe(2.8);
      expect(estimateDialogueDuration(text, 'hold')).toBe(3.3);
    });

    it('ignores whitespace when counting characters', () => {
      expect(estimateDialogueDuration('我想把 这句话 说清楚。', 'normal')).toBe(2.2);
    });

    it('clamps the base estimate to a minimum and maximum', () => {
      expect(estimateDialogueDuration('', 'normal')).toBe(1.6);
      expect(estimateDialogueDuration('短', 'hold')).toBe(2.4);
    });

    it('clamps the final estimate per pace tier', () => {
      const longText = '很'.repeat(200);
      expect(estimateDialogueDuration(longText, 'normal')).toBe(7);
      expect(estimateDialogueDuration(longText, 'hold')).toBe(9);
    });
  });

  describe('estimateDialogueDurationByReadingSpeed (per-char estimate)', () => {
    it('applies the default per-char baseline', () => {
      expect(DEFAULT_DIALOGUE_DURATION_OPTIONS).toEqual({
        perCharSeconds: 0.25,
        baseSeconds: 1,
        minSeconds: 1.5,
        maxSeconds: 12,
        speed: 1.5,
      });
    });

    it('adds base seconds plus per-character seconds divided by speed', () => {
      expect(estimateDialogueDurationByReadingSpeed('你好')).toBe(1.5);
      expect(estimateDialogueDurationByReadingSpeed('第一句旁白')).toBeCloseTo(1.8333, 4);
    });

    it('clamps to the minimum and maximum duration', () => {
      expect(estimateDialogueDurationByReadingSpeed('')).toBe(1.5);
      expect(estimateDialogueDurationByReadingSpeed('很'.repeat(100))).toBe(12);
    });

    it('scales durations by the reading speed', () => {
      const text = '很长的一段旁白文字，用来测试阅读速度对估算时长的影响。';
      const slow = estimateDialogueDurationByReadingSpeed(text, { speed: 0.5 });
      const fast = estimateDialogueDurationByReadingSpeed(text, { speed: 2 });
      expect(slow).toBeGreaterThan(fast);
    });

    it('accepts per-field overrides', () => {
      expect(estimateDialogueDurationByReadingSpeed('你好', { perCharSeconds: 0.5 }))
        .toBeCloseTo(1.6667, 4);
      expect(estimateDialogueDurationByReadingSpeed('第一句旁白', { perCharSeconds: 0.5 }))
        .toBeCloseTo(2.6667, 4);
    });

    it('falls back to the default speed when the override is not a positive number', () => {
      expect(estimateDialogueDurationByReadingSpeed('第一句旁白', { speed: 0 }))
        .toBeCloseTo(1.8333, 4);
    });
  });

  describe('dialogue duration policy', () => {
    it('uses the manual setting override for UI defaults and clamps it at the policy seam', () => {
      expect(resolveDialogueDuration({
        context: 'manual-default',
        defaultDurationSeconds: 4.5,
      })).toBe(4.5);
      expect(resolveDialogueDuration({
        context: 'manual-default',
        defaultDurationSeconds: 100,
      })).toBe(20);
      expect(resolveDialogueDuration({
        context: 'manual-default',
        defaultDurationSeconds: Number.NaN,
      })).toBe(2);
    });

    it('keeps pace-tier estimation explicit for authoring and AI paths', () => {
      expect(resolveDialogueDuration({
        context: 'pace-tier',
        text: '我想把这句话说清楚。',
        pace: 'slow',
      })).toBe(2.8);
    });

    it('keeps reading-speed estimation explicit for imports', () => {
      expect(resolveDialogueDuration({
        context: 'reading-speed',
        text: '第一句旁白',
      })).toBeCloseTo(1.8333, 4);
    });

    it('preserves authored duration for manual time or duration edits and recomputes otherwise', () => {
      expect(resolveDialogueDuration({
        context: 'authoring-update',
        text: '我想把这句话说清楚。',
        pace: 'slow',
        authoredDurationSeconds: 6.5,
        timeWasEdited: false,
        durationWasEdited: true,
      })).toBe(6.5);
      expect(resolveDialogueDuration({
        context: 'authoring-update',
        text: '我想把这句话说清楚。',
        pace: 'slow',
        authoredDurationSeconds: 4,
        timeWasEdited: true,
        durationWasEdited: false,
      })).toBe(4);
      expect(resolveDialogueDuration({
        context: 'authoring-update',
        text: '我想把这句话说清楚。',
        pace: 'slow',
        authoredDurationSeconds: 1,
        timeWasEdited: false,
        durationWasEdited: false,
      })).toBe(2.8);
    });
  });

  describe('pace coverage', () => {
    it('covers every pace tier in every table', () => {
      const paces: AiRhythmPace[] = ['snap', 'normal', 'slow', 'hold'];
      for (const pace of paces) {
        expect(typeof PACE_GAP[pace]).toBe('number');
        expect(typeof PACE_MULTIPLIER[pace]).toBe('number');
        expect(typeof PACE_PAUSE_DURATION[pace]).toBe('number');
      }
    });
  });
});
