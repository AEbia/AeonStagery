// Camera motion zoom draft: reads absolute/delta values from source params (ADR-0022 camera statements).
export type CameraPoint = [number, number];

export function clampCameraCoordinate(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

export function readCameraPoint(
  value: unknown,
  fallback: CameraPoint = [0.5, 0.5],
  min = 0,
  max = 1,
): CameraPoint {
  const point = Array.isArray(value) ? value : [];
  const x = typeof point[0] === 'number' && Number.isFinite(point[0]) ? point[0] : fallback[0];
  const y = typeof point[1] === 'number' && Number.isFinite(point[1]) ? point[1] : fallback[1];
  return [clampCameraCoordinate(x, min, max), clampCameraCoordinate(y, min, max)];
}

export type CameraMotionZoomKind = 'absolute' | 'delta';

export interface CameraMotionZoomDraft {
  kind: CameraMotionZoomKind;
  value: number;
}

export function readCameraMotionZoom(
  value: unknown,
  move: string,
  legacyDelta?: unknown,
): CameraMotionZoomDraft {
  if (typeof value === 'string') {
    const relative = value.match(/^([+-])=\s*(-?(?:\d+\.?\d*|\.\d+))$/);
    if (relative) {
      const magnitude = Number(relative[2]);
      if (Number.isFinite(magnitude)) {
        return { kind: 'delta', value: relative[1] === '-' ? -Math.abs(magnitude) : Math.abs(magnitude) };
      }
    }
    const absolute = Number(value);
    if (Number.isFinite(absolute)) return { kind: 'absolute', value: absolute };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { kind: 'absolute', value };
  }
  if (typeof legacyDelta === 'number' && Number.isFinite(legacyDelta)) {
    return { kind: 'delta', value: legacyDelta };
  }
  if (move === 'push') return { kind: 'delta', value: 0.3 };
  if (move === 'pull') return { kind: 'delta', value: -0.3 };
  return { kind: 'absolute', value: 1 };
}

export function serializeCameraMotionZoom(zoom: CameraMotionZoomDraft): number | string {
  if (zoom.kind === 'absolute') return Math.max(0, zoom.value);
  return zoom.value >= 0 ? `+=${zoom.value}` : `-=${Math.abs(zoom.value)}`;
}
