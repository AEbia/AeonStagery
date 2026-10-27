import { describe, expect, it } from 'vitest';
import { getLogicalStageSize, getOutputViewport, validateVideoFormat } from '../api/types/video-format';

describe('project and output format', () => {
  it('preserves composition when raising 1080p to 4K', () => {
    expect(getLogicalStageSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(getLogicalStageSize({ width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080 });
    expect(getOutputViewport({ width: 1920, height: 1080 }, { width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080, scale: 2, x: 0, y: 0 });
  });

  it('uses portrait and square authoring surfaces without stretching', () => {
    expect(getLogicalStageSize({ width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920 });
    expect(getLogicalStageSize({ width: 2160, height: 2160 })).toEqual({ width: 1080, height: 1080 });
  });

  it('centers a landscape scene within a square output or crops its sides', () => {
    expect(getOutputViewport({ width: 1920, height: 1080 }, { width: 1920, height: 1920 })).toEqual({ width: 1920, height: 1920, scale: 1, x: 0, y: 420 });
    const crop = getOutputViewport({ width: 1920, height: 1080 }, { width: 1920, height: 1920 }, 'cover');
    expect(crop.scale).toBeCloseTo(16 / 9);
    expect(crop.x).toBe(-420);
    expect(crop.y).toBe(0);
  });

  it.each([
    { width: 0, height: 1080, fps: 60 },
    { width: 1921, height: 1080, fps: 60 },
    { width: 9000, height: 1080, fps: 60 },
    { width: 1920, height: 1080, fps: NaN },
    { width: 1920, height: 1080, fps: 0 },
    { width: 1920, height: 1080, fps: 241 },
  ])('rejects unsupported output dimensions or rate: %j', format => {
    expect(validateVideoFormat(format)).not.toBeNull();
  });

  it('accepts fractional frame rates', () => {
    expect(validateVideoFormat({ width: 3840, height: 2160, fps: 29.97 })).toBeNull();
  });
});
