export interface PreviewBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PreviewViewport {
  width: number;
  height: number;
}

export type PreviewSide = 'left' | 'right' | 'top' | 'bottom';
export interface PreviewLayout extends PreviewBounds { side: PreviewSide }

const MARGIN = 12;
const GAP = 12;
const CHROME_HEIGHT = 88;
const VIEWPORT_RATIO = 340 / 320;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Keep both automatic placement and a manually dragged window reachable after resizing. */
export function constrainPreviewBounds(bounds: PreviewBounds, viewport: PreviewViewport): PreviewBounds {
  const width = Math.min(bounds.width, Math.max(1, viewport.width - MARGIN * 2));
  const height = Math.min(bounds.height, Math.max(1, viewport.height - MARGIN * 2));
  return {
    left: clamp(bounds.left, MARGIN, viewport.width - MARGIN - width),
    top: clamp(bounds.top, MARGIN, viewport.height - MARGIN - height),
    width,
    height,
  };
}

/** Prefer a readable portrait viewport beside the whole picker, including its open list. */
export function placeResourcePreview(anchor: PreviewBounds, viewport: PreviewViewport): PreviewLayout {
  const usableWidth = Math.max(1, viewport.width - MARGIN * 2);
  const usableHeight = Math.max(1, viewport.height - MARGIN * 2);
  const preferredWidth = Math.min(clamp(viewport.width * 0.24, 280, 360), usableWidth);
  const preferredHeight = Math.min(preferredWidth * VIEWPORT_RATIO + CHROME_HEIGHT, 480, usableHeight);
  const minWidth = Math.min(220, usableWidth);
  const minHeight = Math.min(240, usableHeight);
  const right = viewport.width - MARGIN;
  const bottom = viewport.height - MARGIN;
  const anchorRight = anchor.left + anchor.width;
  const anchorBottom = anchor.top + anchor.height;
  const regions: Array<PreviewBounds & { side: PreviewSide }> = [
    { side: 'right', left: Math.max(MARGIN, anchorRight + GAP), top: MARGIN,
      width: right - Math.max(MARGIN, anchorRight + GAP), height: usableHeight },
    { side: 'left', left: MARGIN, top: MARGIN,
      width: Math.min(right, anchor.left - GAP) - MARGIN, height: usableHeight },
    { side: 'bottom', left: MARGIN, top: Math.max(MARGIN, anchorBottom + GAP),
      width: usableWidth, height: bottom - Math.max(MARGIN, anchorBottom + GAP) },
    { side: 'top', left: MARGIN, top: MARGIN,
      width: usableWidth, height: Math.min(bottom, anchor.top - GAP) - MARGIN },
  ];
  let best: PreviewLayout | null = null;
  let bestScore = -Infinity;
  for (const region of regions) {
    if (region.width < minWidth || region.height < minHeight) continue;
    const height = Math.min(preferredHeight, region.height);
    const width = Math.min(preferredWidth, region.width, Math.max(minWidth, (height - CHROME_HEIGHT) / VIEWPORT_RATIO));
    const horizontal = region.side === 'left' || region.side === 'right';
    const score = width * (height - CHROME_HEIGHT) * (horizontal ? 1.12 : 1);
    if (score <= bestScore) continue;
    bestScore = score;
    best = {
      side: region.side, width, height,
      left: horizontal
        ? (region.side === 'left' ? region.left + region.width - width : region.left)
        : clamp(anchorRight - width, region.left, region.left + region.width - width),
      top: horizontal
        ? clamp(anchor.top, region.top, region.top + region.height - height)
        : (region.side === 'top' ? region.top + region.height - height : region.top),
    };
  }
  if (best) return best;

  // Very narrow workspaces have no non-overlapping region: minimize coverage of the list.
  const corners: PreviewLayout[] = [
    { left: MARGIN, top: MARGIN, side: 'left', width: preferredWidth, height: preferredHeight },
    { left: right - preferredWidth, top: MARGIN, side: 'right', width: preferredWidth, height: preferredHeight },
    { left: MARGIN, top: bottom - preferredHeight, side: 'left', width: preferredWidth, height: preferredHeight },
    { left: right - preferredWidth, top: bottom - preferredHeight, side: 'right', width: preferredWidth, height: preferredHeight },
  ];
  const overlap = (bounds: PreviewBounds) =>
    Math.max(0, Math.min(bounds.left + bounds.width, anchorRight) - Math.max(bounds.left, anchor.left))
    * Math.max(0, Math.min(bounds.top + bounds.height, anchorBottom) - Math.max(bounds.top, anchor.top));
  return corners.reduce((result, candidate) => overlap(candidate) < overlap(result) ? candidate : result);
}
