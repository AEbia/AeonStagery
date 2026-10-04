import { describe, expect, it } from 'vitest';
import { buildCurvePresetSegment, CURVE_PRESETS, resolveCurvePresetId } from '../ui/timeline/curvePresets';

const PREV = { time: 1, value: 100 };
const NEXT = { time: 3, value: 200 };

describe('buildCurvePresetSegment', () => {
  it('returns a linear segment for the linear preset', () => {
    expect(buildCurvePresetSegment('linear', PREV, NEXT)).toEqual({ type: 'linear' });
  });

  it('rejects unknown preset ids', () => {
    expect(buildCurvePresetSegment('bounce', PREV, NEXT)).toBeNull();
    expect(buildCurvePresetSegment('', PREV, NEXT)).toBeNull();
  });

  it('rejects degenerate spans that cannot host both control points', () => {
    expect(buildCurvePresetSegment('smooth', PREV, { ...NEXT, time: PREV.time })).toBeNull();
    expect(buildCurvePresetSegment('smooth', PREV, { ...NEXT, time: PREV.time - 1 })).toBeNull();
    expect(buildCurvePresetSegment('smooth', PREV, { ...NEXT, time: PREV.time + 0.015 })).toBeNull();
  });

  it('maps the smooth preset to a symmetric S-curve', () => {
    const segment = buildCurvePresetSegment('smooth', PREV, NEXT);
    expect(segment).toEqual({
      type: 'bezier',
      controlPoints: [
        { time: 1.7, value: 100 },
        { time: 2.3, value: 200 },
      ],
    });
  });

  it('ramps value early for easeOut', () => {
    const segment = buildCurvePresetSegment('easeOut', PREV, NEXT);
    if (segment?.type !== 'bezier') throw new Error('expected bezier segment');
    const [cp1] = segment.controlPoints;
    expect(cp1).toEqual({ time: round2(PREV.time + 2 * 0.15), value: 155 });
  });

  it('overshoots beyond the target value for backOut', () => {
    const segment = buildCurvePresetSegment('backOut', PREV, NEXT);
    if (segment?.type !== 'bezier') throw new Error('expected bezier segment');
    const [cp1, cp2] = segment.controlPoints;
    expect(cp1.value).toBeGreaterThan(NEXT.value); // 冲过目标
    expect(cp2.value).toBeCloseTo(NEXT.value + 0.05 * (NEXT.value - PREV.value), 5);
  });

  it.each(['smooth', 'easeOut', 'easeIn', 'snappy', 'backOut'] as const)(
    'keeps control point times strictly inside the segment span for %s',
    (presetId) => {
      const segment = buildCurvePresetSegment(presetId, PREV, NEXT);
      if (segment?.type !== 'bezier') throw new Error('expected bezier segment');
      const [cp1, cp2] = segment.controlPoints;
      expect(cp1.time).toBeGreaterThan(PREV.time);
      expect(cp1.time).toBeLessThanOrEqual(cp2.time);
      expect(cp2.time).toBeLessThan(NEXT.time);
    },
  );

  it('supports descending values (negative dy)', () => {
    const segment = buildCurvePresetSegment('easeOut', { time: 1, value: 200 }, { time: 3, value: 100 });
    if (segment?.type !== 'bezier') throw new Error('expected bezier segment');
    const [cp1] = segment.controlPoints;
    // dy = -100, ratio 0.55 → 200 - 55 = 145
    expect(cp1.value).toBe(145);
  });

  it('snaps results to two decimals', () => {
    const segment = buildCurvePresetSegment('easeIn', { time: 0.33, value: 0 }, { time: 1.17, value: 7 });
    if (segment?.type !== 'bezier') throw new Error('expected bezier segment');
    for (const cp of segment.controlPoints) {
      expect(Number.isInteger(cp.time * 100)).toBe(true);
      expect(Number.isInteger(cp.value * 100)).toBe(true);
    }
  });
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

describe('resolveCurvePresetId', () => {
  it.each(CURVE_PRESETS)('recognizes persisted $id control points', ({ id }) => {
    expect(resolveCurvePresetId(buildCurvePresetSegment(id, PREV, NEXT)!, PREV, NEXT)).toBe(id);
  });

  it('recognizes rounded presets with descending or constant values', () => {
    for (const nextValue of [-7, 0]) {
      const prev = { time: 0.33, value: 0 };
      const next = { time: 1.17, value: nextValue };
      for (const { id } of CURVE_PRESETS) {
        expect(resolveCurvePresetId(buildCurvePresetSegment(id, prev, next)!, prev, next)).toBe(id);
      }
    }
  });

  it('recognizes exact imported normalized curves without rounding their points', () => {
    const prev = { time: 0.123, value: 0.123 };
    const next = { time: 1.246, value: 3.456 };
    expect(resolveCurvePresetId({ type: 'bezier', controlPoints: [
      { time: prev.time + (next.time - prev.time) * 0.35, value: prev.value },
      { time: prev.time + (next.time - prev.time) * 0.65, value: next.value },
    ] }, prev, next)).toBe('smooth');
  });

  it('displays custom and stepped interpolation honestly', () => {
    expect(resolveCurvePresetId({ type: 'bezier', controlPoints: [{ time: 1.5, value: 123 }, { time: 2.5, value: 170 }] }, PREV, NEXT)).toBe('custom');
    expect(resolveCurvePresetId({ type: 'stepped' }, PREV, NEXT)).toBe('stepped');
    expect(resolveCurvePresetId({ type: 'inverseStepped' }, PREV, NEXT)).toBe('inverseStepped');
    expect(resolveCurvePresetId(undefined, PREV, NEXT)).toBe('linear');
  });
});
