import * as PIXI from 'pixi.js';
import type { TargetEnvironmentOverride, VisualTargetId } from '../../api/types/visual';
import { stageManager } from '../StageManager';
import { live2DManager } from '../Live2DManager';
import { BACKGROUND_LAYER_ID, STAGE_HEIGHT, STAGE_WIDTH } from '../environmentLayerModel';
import { DEFAULT_FOCAL_LENGTH } from '../Projection';
import { resolveVec2 } from '../utils/math';
import {
  averageColor,
  clamp,
  cloneColorStops,
  colorChannels,
  luminanceOfColor,
  mixColor,
  packColor,
  parseColor,
  saturateColor,
  saturationOfColor,
  scaleColor,
  type ColorStopSet,
} from './compositeColor';

interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type EnvironmentSamplingMode = 'interactive' | 'export';
const INTERACTIVE_PROBE_SMOOTH_DT_CAP_SECONDS = 1 / 24;
const INITIAL_PROBE_SMOOTH_DT_SECONDS = 1 / 120;
const EXPORT_PROBE_SMOOTH_DT_SECONDS = 1 / 60;
const PROBE_SMOOTH_STEP_SECONDS = 1 / 60;
const BACKWARD_TIME_EPSILON_SECONDS = 1 / 120;

export interface EnvironmentProbeSnapshot {
  color: number;
  colorStops: ColorStopSet;
  luma: number;
  saturation: number;
  shadowColor: number;
  shadowRotation: number;
}

interface EnvironmentProbeState {
  smoothingRemainder: number;
  raw: EnvironmentProbeSnapshot | null;
  display: EnvironmentProbeSnapshot | null;
  lastAppliedTime: number | null;
}

interface BackgroundProbeCache {
  data: Uint8ClampedArray | null;
  width: number;
  height: number;
  lastSampleTime: number;
  lastSampleKey: string | null;
  lastCompositionKey: string | null;
  lastObservedBounds: RectLike | null;
  coordinateSpace: 'screen' | 'background-local';
}

interface EnvironmentLayerProxySnapshot {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  z?: number;
}

// Sampling also reads legacy texture metadata and stage-owned display metadata.
interface ProbeTextureSource {
  resource?: { source?: CanvasImageSource };
  realSource?: CanvasImageSource;
  uid?: string | number;
  dirtyId?: number;
  _resourceId?: number;
}

interface ProbeTexture {
  source?: ProbeTextureSource;
  baseTexture?: ProbeTextureSource;
  resource?: { source?: CanvasImageSource };
  textureCacheIds?: readonly string[];
}

type ProbeDisplayObject = PIXI.Container & {
  texture?: ProbeTexture;
  anchor?: PIXI.PointData;
  tilePosition?: PIXI.PointData;
  tileScale?: PIXI.PointData;
  __imageKey?: string;
  __layoutMode?: string;
  __baseAlpha?: number;
  __transitionAlpha?: number;
};

function getDisplayBounds(displayObject: PIXI.Container | null): RectLike | null {
  if (!displayObject || typeof displayObject.getBounds !== 'function') return null;
  try {
    return displayObject.getBounds() as RectLike;
  } catch {
    return null;
  }
}

function getEffectiveEnvironmentZ(backgroundTarget: PIXI.Container): number {
  const parentZ = Number(backgroundTarget.parent?.zIndex);
  if (Number.isFinite(parentZ)) return parentZ;
  const ownZ = Number(backgroundTarget.zIndex);
  return Number.isFinite(ownZ) ? ownZ : 0;
}

function getCameraNeutralDisplayOrigin(
  backgroundTarget: PIXI.Container,
  camera?: { position: import('../../api/types/common').Vec2; zoom: number } | null,
): { x: number; y: number; scaleX: number; scaleY: number; rotation: number } | null {
  const zoom = camera && Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  let x = Number(backgroundTarget.x);
  let y = Number(backgroundTarget.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  if (camera) {
    const position = resolveVec2(camera.position);
    const parallax = 1 + getEffectiveEnvironmentZ(backgroundTarget) / DEFAULT_FOCAL_LENGTH;
    const halfW = STAGE_WIDTH / 2;
    const halfH = STAGE_HEIGHT / 2;
    const worldX = halfW + (x - halfW) / zoom;
    const worldY = halfH + (y - halfH) / zoom;
    x = worldX - (0.5 - position.x) * STAGE_WIDTH * parallax;
    y = worldY - (0.5 - position.y) * STAGE_HEIGHT * parallax;
  }

  const scale = backgroundTarget.scale;
  const scaleX = Number(scale?.x ?? 1) / zoom;
  const scaleY = Number(scale?.y ?? 1) / zoom;
  const rotation = Number(backgroundTarget.rotation ?? 0);
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || Math.abs(scaleX) <= 0.0001 || Math.abs(scaleY) <= 0.0001) {
    return null;
  }

  return {
    x,
    y,
    scaleX,
    scaleY,
    rotation: Number.isFinite(rotation) ? rotation : 0,
  };
}

function getCameraNeutralBackgroundLocalPoint(
  backgroundTarget: PIXI.Container,
  worldX: number,
  worldY: number,
  camera?: { position: import('../../api/types/common').Vec2; zoom: number } | null,
): PIXI.Point | null {
  const origin = getCameraNeutralDisplayOrigin(backgroundTarget, camera);
  if (!origin) return null;

  const dx = worldX - origin.x;
  const dy = worldY - origin.y;
  const cos = Math.cos(origin.rotation);
  const sin = Math.sin(origin.rotation);
  const localX = (dx * cos + dy * sin) / origin.scaleX;
  const localY = (-dx * sin + dy * cos) / origin.scaleY;
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
    return null;
  }
  return new PIXI.Point(localX, localY);
}

function normalizeEnvironmentProxyX(value: number): number {
  return Math.abs(value) <= 2 ? value * STAGE_WIDTH : value;
}

function normalizeEnvironmentProxyY(value: number): number {
  return Math.abs(value) <= 2 ? value * STAGE_HEIGHT : value;
}

function getProxyAnchoredBackgroundLocalPoint(
  worldX: number,
  worldY: number,
  proxy: EnvironmentLayerProxySnapshot,
  backgroundLocalBounds: RectLike,
): PIXI.Point | null {
  const proxyX = Number(proxy.x ?? 0.5);
  const proxyY = Number(proxy.y ?? 0.5);
  const proxyScale = Number(proxy.scale ?? 1);
  const proxyRotation = Number(proxy.rotation ?? 0);
  if (
    !Number.isFinite(proxyX) ||
    !Number.isFinite(proxyY) ||
    !Number.isFinite(proxyScale) ||
    !Number.isFinite(proxyRotation) ||
    Math.abs(proxyScale) <= 0.0001 ||
    backgroundLocalBounds.width <= 0 ||
    backgroundLocalBounds.height <= 0
  ) {
    return null;
  }

  const baseScale = Math.max(
    STAGE_WIDTH / Math.max(1, backgroundLocalBounds.width),
    STAGE_HEIGHT / Math.max(1, backgroundLocalBounds.height),
  );
  const scale = baseScale * proxyScale;
  if (!Number.isFinite(scale) || Math.abs(scale) <= 0.0001) {
    return null;
  }

  const dx = worldX - normalizeEnvironmentProxyX(proxyX);
  const dy = worldY - normalizeEnvironmentProxyY(proxyY);
  const radians = (proxyRotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localX = (dx * cos + dy * sin) / scale;
  const localY = (-dx * sin + dy * cos) / scale;
  if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
    return null;
  }
  return new PIXI.Point(localX, localY);
}

function getBackgroundLocalBounds(backgroundTarget: PIXI.Container): RectLike | null {
  if (typeof backgroundTarget.getLocalBounds !== 'function') return null;
  try {
    return backgroundTarget.getLocalBounds() as RectLike;
  } catch {
    return null;
  }
}

function getCanvasImageSourceDimensions(
  source: CanvasImageSource | null | undefined,
): { width: number; height: number } | null {
  if (!source) return null;
  const candidate = source as {
    width?: number;
    height?: number;
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  };
  const width = candidate.videoWidth ?? candidate.naturalWidth ?? candidate.width ?? 0;
  const height = candidate.videoHeight ?? candidate.naturalHeight ?? candidate.height ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

interface TextureSourceRevision {
  value: number;
}

// PixiJS 8 exposes texture updates as events rather than a stable dirty counter.
const textureSourceRevisions = new WeakMap<object, TextureSourceRevision>();

function getTextureSourceRevision(source: unknown): number {
  if (!source || typeof source !== 'object') return 0;

  let revision = textureSourceRevisions.get(source);
  if (!revision) {
    revision = { value: 0 };
    textureSourceRevisions.set(source, revision);
    const eventSource = source as {
      on?: (event: string, listener: () => void) => unknown;
    };
    if (typeof eventSource.on === 'function') {
      const markUpdated = () => { revision!.value += 1; };
      eventSource.on('update', markUpdated);
    }
  }

  return revision.value;
}

function getBackgroundLocalProbeSource(
  backgroundTarget: PIXI.Container | null,
): { source: CanvasImageSource; width: number; height: number; sampleKey: string } | null {
  if (!backgroundTarget || backgroundTarget instanceof PIXI.TilingSprite) {
    return null;
  }

  const texture = (backgroundTarget as ProbeDisplayObject).texture;
  if (!texture) return null;

  const textureSource = texture.source;
  const baseTexture = texture.baseTexture;
  const source = (
    baseTexture?.resource?.source ||
    textureSource?.resource?.source ||
    textureSource?.resource ||
    texture.resource?.source ||
    baseTexture?.realSource ||
    textureSource
  ) as CanvasImageSource | null | undefined;
  const dimensions = getCanvasImageSourceDimensions(source);
  if (!source || !dimensions) {
    return null;
  }

  const imageKey = (backgroundTarget as ProbeDisplayObject).__imageKey
    ?? texture.textureCacheIds?.[0]
    ?? baseTexture?.uid
    ?? textureSource?.uid
    ?? `${dimensions.width}x${dimensions.height}`;
  const videoTime = typeof (source as HTMLVideoElement).currentTime === 'number'
    ? (source as HTMLVideoElement).currentTime
    : '';
  const sourceRevision = [
    baseTexture?.uid ?? '',
    textureSource?.uid ?? '',
    baseTexture?.dirtyId ?? '',
    textureSource?.dirtyId ?? '',
    textureSource?._resourceId ?? '',
    getTextureSourceRevision(baseTexture),
    getTextureSourceRevision(textureSource),
    videoTime,
  ].join(':');

  return {
    source,
    width: dimensions.width,
    height: dimensions.height,
    sampleKey: `local:${String(imageKey)}:${dimensions.width}x${dimensions.height}:${sourceRevision}`,
  };
}

function getBackgroundStableProbeKey(backgroundTarget: PIXI.Container | null): string {
  const localSource = getBackgroundLocalProbeSource(backgroundTarget);
  if (localSource) {
    return localSource.sampleKey;
  }
  if (!backgroundTarget) {
    return 'background:none';
  }

  const texture = (backgroundTarget as ProbeDisplayObject).texture;
  const baseTexture = texture?.baseTexture;
  const source = (
    baseTexture?.resource?.source ||
    texture?.resource?.source ||
    baseTexture?.realSource ||
    texture?.source
  ) as CanvasImageSource | null | undefined;
  const dimensions = getCanvasImageSourceDimensions(source);

  const imageKey = (backgroundTarget as ProbeDisplayObject).__imageKey
    ?? texture?.textureCacheIds?.[0]
    ?? baseTexture?.uid
    ?? backgroundTarget.name
    ?? backgroundTarget.constructor?.name
    ?? 'unknown';

  const layoutMode = (backgroundTarget as ProbeDisplayObject).__layoutMode ?? 'cover';
  const sizeKey = dimensions ? `${dimensions.width}x${dimensions.height}` : 'unknown-size';
  return `background:${String(imageKey)}:${String(layoutMode)}:${sizeKey}`;
}

function getDisplayCompositionKey(root: PIXI.Container): string {
  const parts: string[] = [];
  const visit = (displayObject: ProbeDisplayObject) => {
    const scale = displayObject.scale;
    const pivot = displayObject.pivot;
    const anchor = displayObject.anchor;
    const tilePosition = displayObject.tilePosition;
    const tileScale = displayObject.tileScale;
    parts.push([
      displayObject.constructor?.name ?? '',
      displayObject.visible === false ? 0 : 1,
      displayObject.renderable === false ? 0 : 1,
      displayObject.alpha ?? 1,
      displayObject.x ?? 0,
      displayObject.y ?? 0,
      displayObject.rotation ?? 0,
      scale?.x ?? 1,
      scale?.y ?? 1,
      pivot?.x ?? 0,
      pivot?.y ?? 0,
      anchor?.x ?? 0,
      anchor?.y ?? 0,
      tilePosition?.x ?? 0,
      tilePosition?.y ?? 0,
      tileScale?.x ?? 1,
      tileScale?.y ?? 1,
      displayObject.zIndex ?? 0,
      displayObject.__imageKey ?? '',
      displayObject.__baseAlpha ?? 1,
      displayObject.__transitionAlpha ?? 1,
    ].join(','));
    for (const child of displayObject.children ?? []) visit(child);
  };
  visit(root);
  return parts.join(';');
}

function environmentProbesEqual(
  left: EnvironmentProbeSnapshot | null,
  right: EnvironmentProbeSnapshot,
): boolean {
  return Boolean(left)
    && left!.color === right.color
    && left!.luma === right.luma
    && left!.saturation === right.saturation
    && left!.shadowColor === right.shadowColor
    && left!.shadowRotation === right.shadowRotation
    && left!.colorStops.every((color, index) => color === right.colorStops[index]);
}

// Probe just outside the stable character bounds; animation must not move the sampling frame.
function createProbeSamplePoints(bounds: RectLike): PIXI.Point[] {
  const sampleBounds = new PIXI.Rectangle(
    bounds.x - bounds.width * 0.08,
    bounds.y - bounds.height * 0.08,
    Math.max(2, bounds.width * 1.16),
    Math.max(2, bounds.height * 1.16),
  );
  return [
    new PIXI.Point(sampleBounds.x, sampleBounds.y),
    new PIXI.Point(sampleBounds.x + sampleBounds.width, sampleBounds.y),
    new PIXI.Point(sampleBounds.x, sampleBounds.y + sampleBounds.height),
    new PIXI.Point(sampleBounds.x + sampleBounds.width, sampleBounds.y + sampleBounds.height),
    new PIXI.Point(sampleBounds.x + sampleBounds.width * 0.5, sampleBounds.y + sampleBounds.height * 0.5),
  ];
}

function buildLocalRegionFromPoints(
  localPoints: PIXI.Point[],
  backgroundLocalBounds: RectLike,
): PIXI.Rectangle | null {
  if (localPoints.length === 0) {
    return null;
  }

  const minX = Math.min(...localPoints.map(point => point.x));
  const maxX = Math.max(...localPoints.map(point => point.x));
  const minY = Math.min(...localPoints.map(point => point.y));
  const maxY = Math.max(...localPoints.map(point => point.y));
  const clampedMinX = clamp(minX, backgroundLocalBounds.x, backgroundLocalBounds.x + backgroundLocalBounds.width);
  const clampedMaxX = clamp(maxX, backgroundLocalBounds.x, backgroundLocalBounds.x + backgroundLocalBounds.width);
  const clampedMinY = clamp(minY, backgroundLocalBounds.y, backgroundLocalBounds.y + backgroundLocalBounds.height);
  const clampedMaxY = clamp(maxY, backgroundLocalBounds.y, backgroundLocalBounds.y + backgroundLocalBounds.height);

  if (clampedMaxX - clampedMinX < 0.5 || clampedMaxY - clampedMinY < 0.5) {
    return null;
  }

  return new PIXI.Rectangle(
    clampedMinX,
    clampedMinY,
    clampedMaxX - clampedMinX,
    clampedMaxY - clampedMinY,
  );
}

function mapWorldBoundsToBackgroundLocalRegion(
  backgroundTarget: PIXI.Container,
  worldBounds: RectLike,
  backgroundLocalBounds: RectLike,
  environmentProxy?: EnvironmentLayerProxySnapshot | null,
  camera?: { position: import('../../api/types/common').Vec2; zoom: number } | null,
): PIXI.Rectangle | null {
  if (backgroundLocalBounds.width <= 0 || backgroundLocalBounds.height <= 0) {
    return null;
  }

  const localPoints = createProbeSamplePoints(worldBounds)
    .map(point => (
      environmentProxy
        ? getProxyAnchoredBackgroundLocalPoint(point.x, point.y, environmentProxy, backgroundLocalBounds)
        : getCameraNeutralBackgroundLocalPoint(backgroundTarget, point.x, point.y, camera)
    ))
    .filter((point): point is PIXI.Point => Boolean(point));
  return buildLocalRegionFromPoints(localPoints, backgroundLocalBounds);
}

function cloneBounds(bounds: RectLike | null): PIXI.Rectangle | null {
  if (!bounds) return null;
  return new PIXI.Rectangle(bounds.x, bounds.y, bounds.width, bounds.height);
}

function computeBoundsMotionScore(previous: RectLike | null, next: RectLike | null): number {
  if (!previous || !next) return 0;
  return Math.max(
    Math.abs(previous.x - next.x),
    Math.abs(previous.y - next.y),
    Math.abs(previous.width - next.width),
    Math.abs(previous.height - next.height),
  );
}

function adjustEnvironmentColor(color: number, override?: TargetEnvironmentOverride): number {
  let next = color;
  if (override?.environmentColor) {
    const parsed = parseColor(override.environmentColor);
    if (parsed !== null) {
      next = parsed;
    }
  }
  if (typeof override?.warmthBias === 'number' && Math.abs(override.warmthBias) > 0.001) {
    const warmth = clamp(override.warmthBias, -1, 1);
    const warmTarget = warmth >= 0 ? 0xd6a374 : 0x7aa8d8;
    next = mixColor(next, warmTarget, Math.abs(warmth) * 0.22);
    next = saturateColor(next, warmth * 0.08);
  }
  if (typeof override?.exposureBias === 'number' && Math.abs(override.exposureBias) > 0.001) {
    next = scaleColor(next, 1 + clamp(override.exposureBias, -1, 1) * 0.18);
  }
  return next;
}

function resolveShadowRotation(probeRotation: number, override?: TargetEnvironmentOverride): number {
  switch (override?.primaryLightDirection) {
    case 'left':
      return 118;
    case 'right':
      return 62;
    case 'center':
      return 90;
    case 'mixed':
      return 90;
    default:
      return probeRotation;
  }
}

function createFallbackProbe(baseColor: number, override?: TargetEnvironmentOverride): EnvironmentProbeSnapshot {
  const adjustedColor = adjustEnvironmentColor(baseColor, override);
  const shadowBase = mixColor(scaleColor(adjustedColor, 0.34), 0x202734, 0.45);
  return {
    color: adjustedColor,
    colorStops: [adjustedColor, adjustedColor, adjustedColor, adjustedColor],
    luma: luminanceOfColor(adjustedColor),
    saturation: saturationOfColor(adjustedColor),
    shadowColor: shadowBase,
    shadowRotation: resolveShadowRotation(90, override),
  };
}

function sampleBilinearColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const clampedX = clamp(x, 0, Math.max(0, width - 1));
  const clampedY = clamp(y, 0, Math.max(0, height - 1));
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;

  const sample = (sx: number, sy: number) => {
    const index = (sy * width + sx) * 4;
    return {
      r: data[index],
      g: data[index + 1],
      b: data[index + 2],
      a: data[index + 3] / 255,
    };
  };

  const c00 = sample(x0, y0);
  const c10 = sample(x1, y0);
  const c01 = sample(x0, y1);
  const c11 = sample(x1, y1);

  const interpolate = (v00: number, v10: number, v01: number, v11: number) => {
    const top = v00 + (v10 - v00) * tx;
    const bottom = v01 + (v11 - v01) * tx;
    return top + (bottom - top) * ty;
  };

  const alpha = interpolate(c00.a, c10.a, c01.a, c11.a);
  if (alpha <= 0.001) {
    return 0x808080;
  }

  return packColor(
    interpolate(c00.r, c10.r, c01.r, c11.r),
    interpolate(c00.g, c10.g, c01.g, c11.g),
    interpolate(c00.b, c10.b, c01.b, c11.b),
  );
}

function sampleKernelAverageColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
): number {
  const offsets = [-1, 0, 1];
  let totalWeight = 0;
  let r = 0;
  let g = 0;
  let b = 0;

  for (const oy of offsets) {
    for (const ox of offsets) {
      const weight = (ox === 0 ? 1.4 : 0.8) * (oy === 0 ? 1.4 : 0.8);
      const color = sampleBilinearColor(
        data,
        width,
        height,
        centerX + ox * radiusX,
        centerY + oy * radiusY,
      );
      const channels = colorChannels(color);
      totalWeight += weight;
      r += channels.r * weight;
      g += channels.g * weight;
      b += channels.b * weight;
    }
  }

  if (totalWeight <= 0.001) {
    return 0x808080;
  }
  return packColor(r / totalWeight, g / totalWeight, b / totalWeight);
}

function inferContinuousShadowRotation(topLeft: number, topRight: number, bottomLeft: number, bottomRight: number): number {
  const leftLuma = (luminanceOfColor(topLeft) + luminanceOfColor(bottomLeft)) / 2;
  const rightLuma = (luminanceOfColor(topRight) + luminanceOfColor(bottomRight)) / 2;
  const lumaDelta = leftLuma - rightLuma;
  return 90 + clamp(lumaDelta * 140, -28, 28);
}

function buildProbeFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  override?: TargetEnvironmentOverride,
): EnvironmentProbeSnapshot {
  const radiusX = Math.max(1, width * 0.09);
  const radiusY = Math.max(1, height * 0.09);
  const topLeft = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, width * 0.28, height * 0.28, radiusX, radiusY), override);
  const topRight = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, width * 0.72, height * 0.28, radiusX, radiusY), override);
  const bottomLeft = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, width * 0.28, height * 0.72, radiusX, radiusY), override);
  const bottomRight = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, width * 0.72, height * 0.72, radiusX, radiusY), override);
  const colorStops: ColorStopSet = [topLeft, topRight, bottomLeft, bottomRight];
  const average = averageColor(colorStops);
  const inferredRotation = inferContinuousShadowRotation(topLeft, topRight, bottomLeft, bottomRight);
  const darkness = 0.28 + (1 - luminanceOfColor(average)) * 0.2;
  const shadowColor = mixColor(scaleColor(average, darkness), 0x202734, 0.42);

  return {
    color: average,
    colorStops,
    luma: luminanceOfColor(average),
    saturation: saturationOfColor(average),
    shadowColor,
    shadowRotation: resolveShadowRotation(inferredRotation, override),
  };
}

function buildProbeFromRegion(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number,
  override?: TargetEnvironmentOverride,
): EnvironmentProbeSnapshot {
  const safeXStart = clamp(xStart, 0, Math.max(0, width - 1));
  const safeXEnd = clamp(xEnd, safeXStart + 1, width);
  const safeYStart = clamp(yStart, 0, Math.max(0, height - 1));
  const safeYEnd = clamp(yEnd, safeYStart + 1, height);
  const sampleX = (t: number) => safeXStart + (safeXEnd - safeXStart) * t;
  const sampleY = (t: number) => safeYStart + (safeYEnd - safeYStart) * t;
  const radiusX = Math.max(0.8, (safeXEnd - safeXStart) * 0.08);
  const radiusY = Math.max(0.8, (safeYEnd - safeYStart) * 0.08);
  const topLeft = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, sampleX(0), sampleY(0), radiusX, radiusY), override);
  const topRight = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, sampleX(1), sampleY(0), radiusX, radiusY), override);
  const bottomLeft = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, sampleX(0), sampleY(1), radiusX, radiusY), override);
  const bottomRight = adjustEnvironmentColor(sampleKernelAverageColor(data, width, height, sampleX(1), sampleY(1), radiusX, radiusY), override);
  const colorStops: ColorStopSet = [topLeft, topRight, bottomLeft, bottomRight];
  const average = averageColor(colorStops);
  const inferredRotation = inferContinuousShadowRotation(topLeft, topRight, bottomLeft, bottomRight);
  const darkness = 0.28 + (1 - luminanceOfColor(average)) * 0.2;
  const shadowColor = mixColor(scaleColor(average, darkness), 0x202734, 0.42);

  return {
    color: average,
    colorStops,
    luma: luminanceOfColor(average),
    saturation: saturationOfColor(average),
    shadowColor,
    shadowRotation: resolveShadowRotation(inferredRotation, override),
  };
}

function cloneProbeSnapshot(snapshot: EnvironmentProbeSnapshot): EnvironmentProbeSnapshot {
  return {
    color: snapshot.color,
    colorStops: cloneColorStops(snapshot.colorStops),
    luma: snapshot.luma,
    saturation: snapshot.saturation,
    shadowColor: snapshot.shadowColor,
    shadowRotation: snapshot.shadowRotation,
  };
}

function applyTargetOverrideToProbe(
  probe: EnvironmentProbeSnapshot,
  override?: TargetEnvironmentOverride,
): EnvironmentProbeSnapshot {
  if (!override) {
    return cloneProbeSnapshot(probe);
  }

  const colorStops = probe.colorStops.map((color) => adjustEnvironmentColor(color, override)) as ColorStopSet;
  const color = adjustEnvironmentColor(probe.color, override);
  const shadowRotation = resolveShadowRotation(probe.shadowRotation, override);
  const darkness = 0.28 + (1 - luminanceOfColor(color)) * 0.2;
  const shadowColor = mixColor(scaleColor(color, darkness), 0x202734, 0.42);

  return {
    color,
    colorStops,
    luma: luminanceOfColor(color),
    saturation: saturationOfColor(color),
    shadowColor,
    shadowRotation,
  };
}

function moveTowards(value: number, target: number, maxDelta: number): number {
  if (target > value) return Math.min(target, value + maxDelta);
  return Math.max(target, value - maxDelta);
}

function moveColorTowards(current: number, target: number, maxChannelDelta: number): number {
  const a = colorChannels(current);
  const b = colorChannels(target);
  return packColor(
    moveTowards(a.r, b.r, maxChannelDelta),
    moveTowards(a.g, b.g, maxChannelDelta),
    moveTowards(a.b, b.b, maxChannelDelta),
  );
}

function smoothProbeSnapshot(from: EnvironmentProbeSnapshot, to: EnvironmentProbeSnapshot, deltaTime: number): EnvironmentProbeSnapshot {
  const dt = Math.max(deltaTime, 0);
  const maxColorStep = 52 * dt;
  const maxLumaStep = 0.22 * dt;
  const maxSaturationStep = 0.32 * dt;
  const maxRotationStep = 42 * dt;

  return {
    color: moveColorTowards(from.color, to.color, maxColorStep),
    colorStops: [
      moveColorTowards(from.colorStops[0], to.colorStops[0], maxColorStep),
      moveColorTowards(from.colorStops[1], to.colorStops[1], maxColorStep),
      moveColorTowards(from.colorStops[2], to.colorStops[2], maxColorStep),
      moveColorTowards(from.colorStops[3], to.colorStops[3], maxColorStep),
    ],
    luma: moveTowards(from.luma, to.luma, maxLumaStep),
    saturation: moveTowards(from.saturation, to.saturation, maxSaturationStep),
    shadowColor: moveColorTowards(from.shadowColor, to.shadowColor, maxColorStep * 0.75),
    shadowRotation: moveTowards(from.shadowRotation, to.shadowRotation, maxRotationStep),
  };
}

/** Owns shared environment pixels and per-character probe continuity across playback, seek and export. */
export class ObjectCompositeEnvironmentProbe {
  private environmentStates = new Map<VisualTargetId, EnvironmentProbeState>();
  private probeCanvas: HTMLCanvasElement | null = null;
  private probeContext: CanvasRenderingContext2D | null = null;
  private backgroundProbeCache: BackgroundProbeCache = {
    data: null,
    width: 0,
    height: 0,
    lastSampleTime: Number.NEGATIVE_INFINITY,
    lastSampleKey: null,
    lastCompositionKey: null,
    lastObservedBounds: null,
    coordinateSpace: 'screen',
  };
  private samplingMode: EnvironmentSamplingMode = 'interactive';
  private snapFirstEnvironmentSample = false;

  constructor(
    private readonly readCurrentProbe: (targetId: VisualTargetId) => EnvironmentProbeSnapshot | null,
  ) {}

  setSamplingMode(mode: EnvironmentSamplingMode): void {
    this.samplingMode = mode;
  }

  invalidate(targetId?: VisualTargetId, options?: { snapToSample?: boolean }): void {
    // Preserve an export/seek snap request across invalidations triggered inside seek().
    if (options?.snapToSample !== undefined) {
      this.snapFirstEnvironmentSample = options.snapToSample;
    }
    if (targetId) {
      this.environmentStates.delete(targetId);
    } else {
      this.environmentStates.clear();
    }
    this.backgroundProbeCache = {
      data: null,
      width: 0,
      height: 0,
      lastSampleTime: Number.NEGATIVE_INFINITY,
      lastSampleKey: null,
      lastCompositionKey: null,
      lastObservedBounds: null,
      coordinateSpace: 'screen',
    };
  }

  sample(
    targetId: VisualTargetId,
    time: number,
    override?: TargetEnvironmentOverride,
  ): EnvironmentProbeSnapshot | null {
    const state = this.getOrCreateEnvironmentState(targetId);
    const { shouldSample, compositionChanged, compositionKey } = this.shouldRefreshBackgroundProbe(time);

    if (shouldSample) {
      this.refreshBackgroundProbe(time, compositionKey);
    }

    // Each character must read the latest shared pixels, including when a previous
    // character refreshed them this frame or this character moved within the image.
    const sampled = this.deriveCharacterProbeFromBackgroundCache(targetId, override);
    const environmentChanged = Boolean(sampled && !environmentProbesEqual(state.raw, sampled));
    if (sampled) {
      state.raw = sampled;
    }

    if (!state.raw) {
      return null;
    }

    const elapsed = state.lastAppliedTime === null ? 0 : time - state.lastAppliedTime;
    const movedBackward = elapsed < -BACKWARD_TIME_EPSILON_SECONDS;
    const smoothingDelta = this.samplingMode === 'export'
      ? EXPORT_PROBE_SMOOTH_DT_SECONDS
      : state.lastAppliedTime === null
        ? INITIAL_PROBE_SMOOTH_DT_SECONDS
        : clamp(Math.max(elapsed, 0), INITIAL_PROBE_SMOOTH_DT_SECONDS, INTERACTIVE_PROBE_SMOOTH_DT_CAP_SECONDS);
    const snapForEnvironmentChange = Boolean(
      state.display
      && environmentChanged
      && compositionChanged
      && elapsed <= BACKWARD_TIME_EPSILON_SECONDS,
    );
    if (!state.display || movedBackward || snapForEnvironmentChange) {
      state.smoothingRemainder = 0;
      const currentProbe = !movedBackward && !snapForEnvironmentChange && !override && !this.snapFirstEnvironmentSample
        ? this.readCurrentProbe(targetId)
        : null;
      state.display = currentProbe
        ? smoothProbeSnapshot(currentProbe, state.raw, smoothingDelta)
        : cloneProbeSnapshot(state.raw);
    } else {
      state.smoothingRemainder += smoothingDelta;
      while (state.smoothingRemainder + 1e-9 >= PROBE_SMOOTH_STEP_SECONDS) {
        state.display = smoothProbeSnapshot(state.display, state.raw, PROBE_SMOOTH_STEP_SECONDS);
        state.smoothingRemainder = Math.max(0, state.smoothingRemainder - PROBE_SMOOTH_STEP_SECONDS);
      }
    }
    state.lastAppliedTime = time;

    return applyTargetOverrideToProbe(state.display, override);
  }

  private getProbeContext(): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null {
    if (typeof document === 'undefined') {
      return null;
    }

    if (!this.probeCanvas) {
      this.probeCanvas = document.createElement('canvas');
      this.probeCanvas.width = 64;
      this.probeCanvas.height = 36;
    }

    if (!this.probeContext) {
      const context = this.probeCanvas.getContext(
        '2d',
        { willReadFrequently: true } as CanvasRenderingContext2DSettings,
      );
      if (!context) {
        this.probeCanvas = null;
        this.probeContext = null;
        return null;
      }
      this.probeContext = context;
    }

    return { canvas: this.probeCanvas, context: this.probeContext };
  }

  private getOrCreateEnvironmentState(targetId: VisualTargetId): EnvironmentProbeState {
    let state = this.environmentStates.get(targetId);
    if (!state) {
      state = {
        smoothingRemainder: 0,
        raw: null,
        display: null,
        lastAppliedTime: null,
      };
      this.environmentStates.set(targetId, state);
    }
    return state;
  }

  private getBackgroundSamplingTarget(): PIXI.Container | null {
    return (
      stageManager.getEnvironmentSamplingContainer?.() ||
      stageManager.getEnvironmentLayerDisplayObject?.(BACKGROUND_LAYER_ID) ||
      stageManager.getBackgroundSprite?.() ||
      stageManager.getLayer('background')
    );
  }

  private getSamplingIntervalSeconds(isMoving: boolean): number {
    if (this.samplingMode === 'export') {
      return 0;
    }
    return isMoving ? 1 / 24 : 1 / 5;
  }

  private shouldRefreshBackgroundProbe(time: number): {
    shouldSample: boolean;
    sampleKey: string;
    isMoving: boolean;
    compositionChanged: boolean;
    compositionKey: string | null;
  } {
    const backgroundTarget = this.getBackgroundSamplingTarget();
    const backgroundLocalSource = getBackgroundLocalProbeSource(backgroundTarget);
    if (backgroundLocalSource) {
      this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
      return {
        shouldSample: !this.backgroundProbeCache.data
        || this.backgroundProbeCache.coordinateSpace !== 'background-local'
          || this.backgroundProbeCache.lastSampleKey !== backgroundLocalSource.sampleKey,
        sampleKey: backgroundLocalSource.sampleKey,
        isMoving: false,
        compositionChanged: false,
        compositionKey: null,
      };
    }

    const backgroundBounds = getDisplayBounds(backgroundTarget);
    const sampleKey = getBackgroundStableProbeKey(backgroundTarget);
    const motionScore = computeBoundsMotionScore(this.backgroundProbeCache.lastObservedBounds, backgroundBounds);
    // A composite can change through fades or layer motion without changing its bounds.
    const isMoving = motionScore > 0.75 || backgroundTarget === stageManager.getEnvironmentSamplingContainer?.();
    const interval = this.getSamplingIntervalSeconds(isMoving);
    const missing = !this.backgroundProbeCache.data;
    const changed = this.backgroundProbeCache.lastSampleKey !== sampleKey;
    const elapsed = time - this.backgroundProbeCache.lastSampleTime;
    const intervalElapsed = interval === 0 ? elapsed > 0 : elapsed >= interval;
    // Composition edits while paused must still invalidate the probe, but walking
    // every environment child on every playback frame is far more expensive than
    // the sampling cadence itself. During playback, the scheduled probe refresh
    // already captures animated changes; only inspect the tree on the first sample
    // or when time is stationary/seeking.
    const shouldCheckComposition = missing || elapsed <= BACKWARD_TIME_EPSILON_SECONDS;
    const currentCompositionKey = backgroundTarget && shouldCheckComposition
      ? getDisplayCompositionKey(backgroundTarget)
      : null;
    const compositionChanged = currentCompositionKey !== null
      && this.backgroundProbeCache.lastCompositionKey !== currentCompositionKey;
    this.backgroundProbeCache.lastObservedBounds = cloneBounds(backgroundBounds);
    return {
      shouldSample: missing || changed || elapsed < -BACKWARD_TIME_EPSILON_SECONDS || intervalElapsed
        || (compositionChanged && elapsed <= 0),
      sampleKey,
      isMoving,
      compositionChanged,
      compositionKey: currentCompositionKey,
    };
  }

  private refreshBackgroundProbe(time: number, compositionKey: string | null = null): void {
    const backgroundTarget = this.getBackgroundSamplingTarget();
    if (!backgroundTarget) {
      this.backgroundProbeCache.data = null;
      this.backgroundProbeCache.width = 0;
      this.backgroundProbeCache.height = 0;
      this.backgroundProbeCache.coordinateSpace = 'screen';
      this.backgroundProbeCache.lastSampleKey = null;
      this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
      return;
    }

    try {
      const backgroundLocalSource = getBackgroundLocalProbeSource(backgroundTarget);
      if (typeof document === 'undefined') {
        this.backgroundProbeCache.data = null;
        this.backgroundProbeCache.width = 0;
        this.backgroundProbeCache.height = 0;
        this.backgroundProbeCache.coordinateSpace = 'screen';
        this.backgroundProbeCache.lastSampleKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        return;
      }
      const probe = this.getProbeContext();
      if (!probe) {
        this.backgroundProbeCache.data = null;
        this.backgroundProbeCache.width = 0;
        this.backgroundProbeCache.height = 0;
        this.backgroundProbeCache.coordinateSpace = 'screen';
        this.backgroundProbeCache.lastSampleKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        return;
      }
      const { canvas: probeCanvas, context } = probe;

      context.clearRect(0, 0, probeCanvas.width, probeCanvas.height);
      if (backgroundLocalSource) {
        context.drawImage(
          backgroundLocalSource.source,
          0,
          0,
          backgroundLocalSource.width,
          backgroundLocalSource.height,
          0,
          0,
          probeCanvas.width,
          probeCanvas.height,
        );
        const imageData = context.getImageData(0, 0, probeCanvas.width, probeCanvas.height);
        this.backgroundProbeCache.data = imageData.data;
        this.backgroundProbeCache.width = probeCanvas.width;
        this.backgroundProbeCache.height = probeCanvas.height;
        this.backgroundProbeCache.lastSampleTime = time;
        this.backgroundProbeCache.lastSampleKey = backgroundLocalSource.sampleKey;
        this.backgroundProbeCache.lastCompositionKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        this.backgroundProbeCache.coordinateSpace = 'background-local';
        return;
      }

      const app = stageManager.getApp();
      const extractCanvas = app.renderer?.extract?.canvas?.bind(app.renderer.extract);
      if (typeof extractCanvas !== 'function') {
        this.backgroundProbeCache.data = null;
        this.backgroundProbeCache.width = 0;
        this.backgroundProbeCache.height = 0;
        this.backgroundProbeCache.coordinateSpace = 'screen';
        this.backgroundProbeCache.lastSampleKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        return;
      }

      // Keep GPU readback small; the probe itself is only 64 x 36 pixels.
      const sampledCanvas = extractCanvas({ target: backgroundTarget, resolution: 1 / 30 }) as HTMLCanvasElement;
      if (!sampledCanvas || sampledCanvas.width <= 0 || sampledCanvas.height <= 0) {
        this.backgroundProbeCache.data = null;
        this.backgroundProbeCache.width = 0;
        this.backgroundProbeCache.height = 0;
        this.backgroundProbeCache.coordinateSpace = 'screen';
        this.backgroundProbeCache.lastSampleKey = null;
        this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
        return;
      }

      context.drawImage(
        sampledCanvas,
        0,
        0,
        sampledCanvas.width,
        sampledCanvas.height,
        0,
        0,
        probeCanvas.width,
        probeCanvas.height,
      );

      const imageData = context.getImageData(0, 0, probeCanvas.width, probeCanvas.height);
      this.backgroundProbeCache.data = imageData.data;
      this.backgroundProbeCache.width = probeCanvas.width;
      this.backgroundProbeCache.height = probeCanvas.height;
      this.backgroundProbeCache.lastSampleTime = time;
      this.backgroundProbeCache.lastSampleKey = getBackgroundStableProbeKey(backgroundTarget);
      if (compositionKey !== null) {
        this.backgroundProbeCache.lastCompositionKey = compositionKey;
      }
      this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
      this.backgroundProbeCache.coordinateSpace = 'screen';
    } catch {
      this.backgroundProbeCache.data = null;
      this.backgroundProbeCache.width = 0;
      this.backgroundProbeCache.height = 0;
      this.backgroundProbeCache.coordinateSpace = 'screen';
      this.backgroundProbeCache.lastSampleKey = null;
      this.backgroundProbeCache.lastObservedBounds = cloneBounds(getDisplayBounds(backgroundTarget));
    }
  }

  private deriveCharacterProbeFromBackgroundCache(
    targetId: VisualTargetId,
    override?: TargetEnvironmentOverride,
  ): EnvironmentProbeSnapshot | null {
    if (!this.backgroundProbeCache.data || this.backgroundProbeCache.width <= 0 || this.backgroundProbeCache.height <= 0) {
      return override?.environmentColor
        ? createFallbackProbe(parseColor(override.environmentColor) ?? 0x808080, override)
        : null;
    }

    const backgroundTarget = this.getBackgroundSamplingTarget();
    const worldTargetBounds = live2DManager.getStableWorldSampleBounds?.(targetId) as RectLike | null | undefined;
    if (!backgroundTarget) {
      return override?.environmentColor
        ? createFallbackProbe(parseColor(override.environmentColor) ?? 0x808080, override)
        : buildProbeFromImageData(this.backgroundProbeCache.data, this.backgroundProbeCache.width, this.backgroundProbeCache.height);
    }

    if (this.backgroundProbeCache.coordinateSpace === 'background-local') {
      const backgroundLocalBounds = getBackgroundLocalBounds(backgroundTarget);
      const environmentProxy = live2DManager.getEnvironmentLayerProxy?.(BACKGROUND_LAYER_ID) as EnvironmentLayerProxySnapshot | null | undefined;
      let localRegion = backgroundLocalBounds && worldTargetBounds
        ? mapWorldBoundsToBackgroundLocalRegion(
            backgroundTarget,
            worldTargetBounds,
            backgroundLocalBounds,
            environmentProxy ?? null,
            environmentProxy ? null : (live2DManager.currentCamera ?? null),
          )
        : null;
      if (backgroundLocalBounds && localRegion) {
        const normalizedXStart = (localRegion.x - backgroundLocalBounds.x) / backgroundLocalBounds.width;
        const normalizedXEnd = (localRegion.x + localRegion.width - backgroundLocalBounds.x) / backgroundLocalBounds.width;
        const normalizedYStart = (localRegion.y - backgroundLocalBounds.y) / backgroundLocalBounds.height;
        const normalizedYEnd = (localRegion.y + localRegion.height - backgroundLocalBounds.y) / backgroundLocalBounds.height;

        return buildProbeFromRegion(
          this.backgroundProbeCache.data,
          this.backgroundProbeCache.width,
          this.backgroundProbeCache.height,
          clamp(normalizedXStart, 0, 1) * this.backgroundProbeCache.width,
          clamp(normalizedXEnd, 0, 1) * this.backgroundProbeCache.width,
          clamp(normalizedYStart, 0, 1) * this.backgroundProbeCache.height,
          clamp(normalizedYEnd, 0, 1) * this.backgroundProbeCache.height,
        );
      }
      return override?.environmentColor
        ? createFallbackProbe(parseColor(override.environmentColor) ?? 0x808080, override)
        : null;
    }

    // Extraction renders the environment container in its local (stage) space.
    // Sample only the region behind this character, rather than the whole stage.
    const environmentBounds = getBackgroundLocalBounds(backgroundTarget);
    const characterBounds = live2DManager.getStableSampleBounds?.(targetId);
    if (environmentBounds && environmentBounds.width > 0 && environmentBounds.height > 0 && characterBounds) {
      const region = buildLocalRegionFromPoints(createProbeSamplePoints(characterBounds), environmentBounds);
      if (region) {
        const { data, width, height } = this.backgroundProbeCache;
        return buildProbeFromRegion(
          data, width, height,
          (region.x - environmentBounds.x) / environmentBounds.width * width,
          (region.x + region.width - environmentBounds.x) / environmentBounds.width * width,
          (region.y - environmentBounds.y) / environmentBounds.height * height,
          (region.y + region.height - environmentBounds.y) / environmentBounds.height * height,
        );
      }
    }
    return buildProbeFromImageData(this.backgroundProbeCache.data, this.backgroundProbeCache.width, this.backgroundProbeCache.height);
  }
}
