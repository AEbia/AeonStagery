import { describe, expect, it } from 'vitest';
import { detectMotionRepeats } from '../engine/MotionRepeatDetector';

describe('detectMotionRepeats', () => {
  it('reports repeated motions for the same character sorted by closest gap', () => {
    const warnings = detectMotionRepeats([
      { action: 'playMotion', time: 10, params: { id: 'tomori', motion: 'wave' } },
      { action: 'dialogue', time: 11, params: { text: 'hello' } },
      { action: 'playMotion', time: 39.94, params: { id: 'tomori', motion: 'wave' } },
      { action: 'playMotion', time: 15.04, params: { id: 'soyo', motion: 'blink' } },
      { action: 'playMotion', time: 16.08, params: { id: 'soyo', motion: 'blink' } },
    ]);

    expect(warnings).toEqual([
      {
        indexA: 3,
        indexB: 4,
        charId: 'soyo',
        motionKey: 'blink',
        gapSeconds: 1,
      },
      {
        indexA: 0,
        indexB: 2,
        charId: 'tomori',
        motionKey: 'wave',
        gapSeconds: 29.9,
      },
    ]);
  });

  it('ignores unrelated actions, incomplete motions, and threshold-boundary repeats', () => {
    expect(detectMotionRepeats([
      { action: 'dialogue', time: 0, params: { id: 'tomori', motion: 'wave' } },
      { action: 'playMotion', time: 1, params: { id: 'tomori' } },
      { action: 'playMotion', time: 2, params: { motion: 'wave' } },
      { action: 'playMotion', time: 3, params: { id: 12, motion: 'wave' } },
      { action: 'playMotion', time: 4, params: { id: 'tomori', motion: 99 } },
      { action: 'playMotion', time: 10, params: { id: 'tomori', motion: 'wave' } },
      { action: 'playMotion', time: 39, params: { id: 'tomori', motion: 'idle' } },
      { action: 'playMotion', time: 40, params: { id: 'soyo', motion: 'wave' } },
      { action: 'playMotion', time: 40, params: { id: 'tomori', motion: 'wave' } },
    ])).toEqual([]);
  });

  it('treats missing action time as zero before comparing sorted adjacent repeats', () => {
    expect(detectMotionRepeats([
      { action: 'playMotion', time: 12, params: { id: 'tomori', motion: 'wave' } },
      { action: 'playMotion', params: { id: 'tomori', motion: 'wave' } },
      { action: 'playMotion', time: 35, params: { id: 'tomori', motion: 'wave' } },
    ], 20)).toEqual([
      {
        indexA: 1,
        indexB: 0,
        charId: 'tomori',
        motionKey: 'wave',
        gapSeconds: 12,
      },
    ]);
  });
});
