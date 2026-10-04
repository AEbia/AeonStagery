import { describe, expect, it } from 'vitest';
import { createStageAnchorResolver } from '../engine/cameraAnchorResolver';

describe('createStageAnchorResolver', () => {
  it('composes the statement-derived base with the measured part offset', () => {
    // The reported bug shape: camera focus targets the chest anchor (upper
    // body), while the statement-derived model position sits lower.
    const resolve = createStageAnchorResolver({
      desiredPosition: () => ({ x: 0.6, y: 0.78 }),
      getPoint: (_id, part) => (part === 'chest' ? { x: 0.62, y: 0.44 } : null),
      getPosition: () => ({ x: 0.6, y: 0.78 }),
    });

    // delta = chest − body = (0.02, −0.34); anchor = base + delta.
    const anchor = resolve('tomori', 'chest');
    expect(anchor).toEqual({ x: 0.62, y: 0.44 });
  });

  it('falls back to the raw live part point without a statement position', () => {
    const resolve = createStageAnchorResolver({
      desiredPosition: () => null,
      getPoint: (_id, part) => (part === 'head' ? { x: 0.5, y: 0.3 } : null),
      getPosition: () => ({ x: 0.55, y: 0.7 }),
    });

    expect(resolve('tomori', 'head')).toEqual({ x: 0.5, y: 0.3 });
  });

  it('falls back to the statement base when model anchors are unavailable', () => {
    const resolve = createStageAnchorResolver({
      desiredPosition: () => ({ x: 0.6, y: 0.78 }),
      getPoint: () => null,
      getPosition: () => null,
    });

    expect(resolve('tomori', 'chest')).toEqual({ x: 0.6, y: 0.78 });
    expect(resolve('tomori')).toEqual({ x: 0.6, y: 0.78 });
  });

  it('resolves the un-parted body anchor for follow-style queries', () => {
    const resolve = createStageAnchorResolver({
      desiredPosition: () => ({ x: 0.6, y: 0.78 }),
      getPoint: () => ({ x: 0.62, y: 0.44 }),
      getPosition: () => ({ x: 0.6, y: 0.78 }),
    });

    // No part → body position, never a part delta.
    expect(resolve('tomori')).toEqual({ x: 0.6, y: 0.78 });
  });

  it('normalizes unknown part names to center and ignores non-finite deltas', () => {
    let requestedPart: string | null = null;
    const resolve = createStageAnchorResolver({
      desiredPosition: () => ({ x: 0.6, y: 0.78 }),
      getPoint: (_id, part) => {
        requestedPart = part;
        return part === 'center' ? { x: Number.NaN, y: 0.5 } : null;
      },
      getPosition: () => ({ x: 0.6, y: 0.78 }),
    });

    expect(resolve('tomori', 'torso' as any)).toEqual({ x: 0.6, y: 0.78 });
    expect(requestedPart).toBe('center');
  });

  it('returns null when nothing can resolve the character', () => {
    const resolve = createStageAnchorResolver({
      desiredPosition: () => null,
      getPoint: () => null,
      getPosition: () => null,
    });

    expect(resolve('ghost', 'head')).toBeNull();
    expect(resolve('ghost')).toBeNull();
  });
});
