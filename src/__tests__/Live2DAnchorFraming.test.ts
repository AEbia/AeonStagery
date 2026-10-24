import { describe, expect, it } from 'vitest';
import { captureLive2DAnchorOffsets, transformLive2DAnchorOffsets } from '../engine/Live2DAnchorGeometry';

describe('bounds-based character framing', () => {
  it('centers the chest above the waist and leaves headroom at the default character scale', () => {
    const offsets = captureLive2DAnchorOffsets({
      getLocalBounds: () => ({ x: 0, y: 0, width: 400, height: 1000 }),
    }, ['head', 'chest'], 1000, null, { x: 200, y: 900 });
    expect(offsets).not.toBeNull();
    const points = transformLive2DAnchorOffsets(offsets!, { position: [0.5, 1.15], scale: 1.3 });
    const chest = points.chest!;
    const top = 1.15 - 0.9 * 1.3;
    const topOnScreen = 0.5 + top - chest.y;
    expect(topOnScreen).toBeGreaterThanOrEqual(0.1);
    expect(topOnScreen).toBeLessThanOrEqual(0.2);
    expect(0.5 + points.head!.y - chest.y).toBeGreaterThan(0.2);
    expect(0.5 + points.head!.y - chest.y).toBeLessThan(0.35);
  });
});
