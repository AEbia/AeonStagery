export function resolveOfficialCubismWebSpriteLayout(
  anchorX: number,
  anchorY: number,
  displayWidth: number,
  displayHeight: number,
): { x: number; y: number; width: number; height: number } {
  const safeWidth = Number.isFinite(displayWidth) && displayWidth > 0 ? displayWidth : 1;
  const safeHeight = Number.isFinite(displayHeight) && displayHeight > 0 ? displayHeight : 1;
  const safeAnchorX = Number.isFinite(anchorX) ? anchorX : 0.5;
  const safeAnchorY = Number.isFinite(anchorY) ? anchorY : 0.9;
  return {
    x: -safeAnchorX * safeWidth,
    y: -safeAnchorY * safeHeight,
    width: safeWidth,
    height: safeHeight,
  };
}
