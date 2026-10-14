import { describe, expect, it } from 'vitest';
import { parseCubism3MotionBuffer, parseCubism3MotionJson } from '../engine/live2d/cubism3MotionParser';

function motion(overrides: Record<string, unknown> = {}) {
  return {
    Version: 3,
    Meta: { Duration: 2, Fps: 60, FadeInTime: 0.25, FadeOutTime: 0.1 },
    Curves: [{
      Target: 'Parameter',
      Id: 'ParamAngleX',
      FadeInTime: 0.1,
      Segments: [0, 0, 0, 1, 1, 0, 2, 0],
    }],
    ...overrides,
  };
}

describe('Cubism 3 Motion3 parser', () => {
  it('converts linear segments and preserves motion metadata', () => {
    const result = parseCubism3MotionJson(motion());
    expect(result.motion.durationSeconds).toBe(2);
    expect(result.motion.fadeInSeconds).toBe(0.25);
    expect(result.motion.derivedFrom).toEqual({ key: 'motion3', fadeInSeconds: 0.25, fadeOutSeconds: 0.1 });
    expect(result.motion.tracks[0]).toEqual({
      parameterId: 'ParamAngleX',
      fadeInSeconds: 0.1,
      keyframes: [
        { time: 0, value: 0, segment: { type: 'linear' } },
        { time: 1, value: 1, segment: { type: 'linear' } },
        { time: 2, value: 0 },
      ],
    });
  });

  it('decodes Bezier, stepped and inverse-stepped segments', () => {
    const result = parseCubism3MotionJson(motion({ Meta: { Duration: 3 }, Curves: [{
      Target: 'Parameter', Id: 'ParamMouthOpenY', Segments: [
        0, 0,
        1, 0.2, 0.1, 0.3, 0.8, 1, 1,
        2, 2, 1,
        3, 3, 0,
      ],
    }] }));
    expect(result.motion.tracks[0].keyframes).toEqual([
      { time: 0, value: 0, segment: { type: 'bezier', controlPoints: [{ time: 0.2, value: 0.1 }, { time: 0.3, value: 0.8 }] } },
      { time: 1, value: 1, segment: { type: 'stepped' } },
      { time: 2, value: 1, segment: { type: 'inverseStepped' } },
      { time: 3, value: 0 },
    ]);
  });

  it('normalizes restricted Bezier control times to one-third points', () => {
    const result = parseCubism3MotionJson(motion({
      Meta: { Duration: 2, AreBeziersRestricted: true },
      Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 1, 99, -99, 88, 77, 2, 1] }],
    }));
    expect(result.motion.tracks[0].keyframes[0].segment).toEqual({
      type: 'bezier',
      controlPoints: [{ time: 2 / 3, value: -99 }, { time: 4 / 3, value: 77 }],
    });
  });

  it('treats the Cubism -1 curve fade sentinel as motion-level inheritance', () => {
    const result = parseCubism3MotionJson(motion({ Curves: [{
      Target: 'Parameter',
      Id: 'ParamAngleX',
      FadeInTime: -1,
      FadeOutTime: -1,
      Segments: [0, 0, 0, 2, 1],
    }] }));
    expect(result.motion.tracks[0].fadeInSeconds).toBeUndefined();
    expect(result.motion.fadeInSeconds).toBe(0.25);
  });

  it('reports non-Parameter curves without silently converting them', () => {
    const result = parseCubism3MotionJson(motion({ Curves: [
      { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 2, 1] },
      { Target: 'PartOpacity', Id: 'PartBody', Segments: [0, 1, 0, 2, 1] },
      { Target: 'Model', Id: 'Opacity', Segments: [0, 1, 0, 2, 1] },
    ] }));
    expect(result.ignoredCurves).toEqual([
      { target: 'PartOpacity', id: 'PartBody' },
      { target: 'Model', id: 'Opacity' },
    ]);
  });

  it('rejects invalid segment data and duplicate parameter ids', () => {
    expect(() => parseCubism3MotionJson(motion({ Curves: [{
      Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 9, 1, 1],
    }] }))).toThrow(/unsupported segment type/);
    expect(() => parseCubism3MotionJson(motion({ Curves: [
      { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 2, 1] },
      { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 2, 1] },
    ] }))).toThrow(/duplicate/);
    expect(() => parseCubism3MotionJson(motion({ Curves: [{
      Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 1, 0.9, 0.1, 0.2, 0.8, 1, 1],
    }] }))).toThrow(/Bezier control point/);
  });

  it('parses a UTF-8 Motion3 buffer', () => {
    const encoded = new TextEncoder().encode(JSON.stringify(motion({ Meta: { Duration: 1 }, Curves: [{
      Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1, 1],
    }] })));
    expect(parseCubism3MotionBuffer(encoded.buffer).motion.durationSeconds).toBe(1);
  });
});
