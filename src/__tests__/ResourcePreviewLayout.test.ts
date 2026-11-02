import { describe, expect, it } from 'vitest';
import { constrainPreviewBounds, placeResourcePreview, type PreviewBounds } from '../ui/live2d/resourcePreviewLayout';

function overlaps(a: PreviewBounds, b: PreviewBounds) {
  return a.left < b.left + b.width && a.left + a.width > b.left
    && a.top < b.top + b.height && a.top + a.height > b.top;
}

describe('resource preview placement', () => {
  it.each([
    { anchor: { left: 1000, top: 100, width: 260, height: 400 }, side: 'left' },
    { anchor: { left: 24, top: 100, width: 300, height: 400 }, side: 'right' },
  ])('keeps the preview beside a $side-facing inspector without covering its list', ({ anchor, side }) => {
    const layout = placeResourcePreview(anchor, { width: 1280, height: 800 });
    expect(layout.side).toBe(side);
    expect(layout.width).toBeGreaterThanOrEqual(280);
    expect(layout.height).toBeGreaterThan(380);
    expect(overlaps(layout, anchor)).toBe(false);
  });

  it('uses space above a wide picker near the bottom when neither side fits comfortably', () => {
    const anchor = { left: 250, top: 520, width: 500, height: 260 };
    const layout = placeResourcePreview(anchor, { width: 900, height: 800 });
    expect(layout.side).toBe('top');
    expect(layout.top + layout.height).toBeLessThan(anchor.top);
    expect(overlaps(layout, anchor)).toBe(false);
  });

  it.each([
    { width: 1600, height: 1000 }, { width: 800, height: 500 },
    { width: 460, height: 320 }, { width: 300, height: 180 },
  ])('keeps all controls inside a $width × $height workspace', (viewport) => {
    const layout = placeResourcePreview({ left: viewport.width - 290, top: 40, width: 280, height: 400 }, viewport);
    expect(layout.left).toBeGreaterThanOrEqual(12);
    expect(layout.top).toBeGreaterThanOrEqual(12);
    expect(layout.left + layout.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(layout.top + layout.height).toBeLessThanOrEqual(viewport.height - 12);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('rescues a manually placed window when its previous bounds no longer fit', () => {
    const layout = constrainPreviewBounds({ left: 1100, top: 600, width: 320, height: 428 }, { width: 640, height: 360 });
    expect(layout).toEqual({ left: 308, top: 12, width: 320, height: 336 });
  });
});
