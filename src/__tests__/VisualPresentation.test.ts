import { describe, expect, it } from 'vitest';
import { getCompositeSlotLabel, getLensSlotLabel, getRecipeDisplayLabel, getVisualModeLabel } from '../ui/timeline/visualPresentation';

describe('visualPresentation', () => {
  it('returns friendly Chinese labels for visual slots and modes', () => {
    expect(getLensSlotLabel('atmosphere')).toBe('空气氛围');
    expect(getCompositeSlotLabel('integration')).toBe('环境融入');
    expect(getVisualModeLabel('latching')).toBe('持续生效');
  });

  it('prefers scene-authored recipe labels over raw recipe ids', () => {
    expect(getRecipeDisplayLabel({
      recipeOverlay: {
        'scene:fog-soft': {
          stack: 'lens',
          slot: 'atmosphere',
          label: '轻雾空气',
          payload: {},
        },
      },
    }, 'scene:fog-soft')).toBe('轻雾空气');

    expect(getRecipeDisplayLabel(undefined, 'builtin:soft-bloom-rgb')).toBe('柔光色差');
  });
});
