import { reconstructEnvironmentAtTime } from '../../engine/EnvironmentLayerRuntime';
import type { EnvironmentLayerRenderImage } from '../../engine/environmentLayerModel';
import type { TimelineScene } from './semanticTimelineTypes';

type SupportedVisualIntentAction = 'setCompositeRecipe';

interface SamplePoint {
  x: number;
  y: number;
}

interface SamplingExclusionRect {
  xMax: number;
  xMin: number;
  yMax: number;
  yMin: number;
}

interface WeightedEnvironmentImage {
  image: string;
  weight: number;
}

interface RgbSample {
  r: number;
  g: number;
  b: number;
}

interface WeightedRgbSample extends RgbSample {
  weight: number;
}

interface LabColor {
  l: number;
  a: number;
  b: number;
}

interface WeightedLabSample extends WeightedRgbSample {
  lab: LabColor;
}

interface ColorCluster extends RgbSample {
  brightness: number;
  lab: LabColor;
  saturation: number;
  weight: number;
}

interface VisionSamplingGroups {
  all: SamplePoint[];
  colorStopStartIndex: number;
  globalCount: number;
  localStartIndex: number;
}

interface VisualSample extends RgbSample {
  brightness: number;
  confidence: number;
  colorStops?: string[];
  saturation: number;
  warmth: number;
}

export interface VisualIntentPresetRequest {
  sceneData: TimelineScene;
  actionType: SupportedVisualIntentAction;
  anchorTime: number;
  baseParams?: Record<string, any>;
  scopeCharId?: string;
}

type EnvironmentSamplingScene = Parameters<typeof reconstructEnvironmentAtTime>[0];

const imageElementCache = new Map<string, Promise<HTMLImageElement | null>>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, step = 0.01): number {
  return Math.round(value / step) * step;
}

function sampleToHex(sample: RgbSample): string {
  const channelToHex = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return `#${channelToHex(sample.r)}${channelToHex(sample.g)}${channelToHex(sample.b)}`;
}

function colorBrightness(sample: RgbSample): number {
  return (0.2126 * sample.r + 0.7152 * sample.g + 0.0722 * sample.b) / 255;
}

function colorSaturation(sample: RgbSample): number {
  const maxChannel = Math.max(sample.r, sample.g, sample.b);
  const minChannel = Math.min(sample.r, sample.g, sample.b);
  return maxChannel <= 0 ? 0 : (maxChannel - minChannel) / maxChannel;
}

function colorWarmth(sample: RgbSample): number {
  return clamp(((sample.r - sample.b) / 255) * 1.8 + ((sample.r - sample.g) / 255) * 0.35, -1, 1);
}

function srgbToLinear(value: number): number {
  const normalized = clamp(value / 255, 0, 1);
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function rgbToOklab(sample: RgbSample): LabColor {
  const r = srgbToLinear(sample.r);
  const g = srgbToLinear(sample.g);
  const b = srgbToLinear(sample.b);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  return {
    l: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  };
}

function labDistance(left: LabColor, right: LabColor): number {
  const dl = (left.l - right.l) * 1.25;
  const da = left.a - right.a;
  const db = left.b - right.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

function analysisWeight(sample: WeightedRgbSample): number {
  const brightness = colorBrightness(sample);
  const saturation = colorSaturation(sample);
  const highlightPenalty = brightness > 0.88 ? clamp((1 - brightness) / 0.12, 0.18, 1) : 1;
  const shadowPenalty = brightness < 0.04 ? 0.35 : 1;
  const saturationPenalty = saturation > 0.72 ? 0.52 : saturation > 0.52 ? 0.74 : 1;
  return Math.max(0, sample.weight) * highlightPenalty * shadowPenalty * saturationPenalty;
}

function prepareLabSamples(samples: WeightedRgbSample[]): WeightedLabSample[] {
  return samples
    .map((sample) => ({
      ...sample,
      lab: rgbToOklab(sample),
      weight: analysisWeight(sample),
    }))
    .filter((sample) => sample.weight > 0.0001);
}

function weightedLabMean(samples: WeightedLabSample[]): LabColor {
  let totalWeight = 0;
  const total = { l: 0, a: 0, b: 0 };
  for (const sample of samples) {
    totalWeight += sample.weight;
    total.l += sample.lab.l * sample.weight;
    total.a += sample.lab.a * sample.weight;
    total.b += sample.lab.b * sample.weight;
  }
  const divisor = Math.max(totalWeight, 0.0001);
  return { l: total.l / divisor, a: total.a / divisor, b: total.b / divisor };
}

function assignColorClusters(samples: WeightedLabSample[], centers: LabColor[]): ColorCluster[] {
  const buckets = centers.map(() => ({
    labL: 0,
    labA: 0,
    labB: 0,
    r: 0,
    g: 0,
    b: 0,
    weight: 0,
  }));

  for (const sample of samples) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < centers.length; index += 1) {
      const distance = labDistance(sample.lab, centers[index]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    const bucket = buckets[bestIndex];
    bucket.labL += sample.lab.l * sample.weight;
    bucket.labA += sample.lab.a * sample.weight;
    bucket.labB += sample.lab.b * sample.weight;
    bucket.r += sample.r * sample.weight;
    bucket.g += sample.g * sample.weight;
    bucket.b += sample.b * sample.weight;
    bucket.weight += sample.weight;
  }

  return buckets
    .filter((bucket) => bucket.weight > 0.0001)
    .map((bucket) => {
      const divisor = Math.max(bucket.weight, 0.0001);
      const color = {
        r: bucket.r / divisor,
        g: bucket.g / divisor,
        b: bucket.b / divisor,
      };
      return {
        ...color,
        brightness: colorBrightness(color),
        lab: {
          l: bucket.labL / divisor,
          a: bucket.labA / divisor,
          b: bucket.labB / divisor,
        },
        saturation: colorSaturation(color),
        weight: bucket.weight,
      };
    });
}

function weightedKMeans(samples: WeightedRgbSample[], clusterCount = 5, iterations = 8): ColorCluster[] {
  const prepared = prepareLabSamples(samples);
  if (prepared.length === 0) return [];

  const centers: LabColor[] = [weightedLabMean(prepared)];
  const targetClusterCount = Math.min(clusterCount, prepared.length);
  while (centers.length < targetClusterCount) {
    let bestSample = prepared[0];
    let bestScore = -1;
    for (const sample of prepared) {
      const nearestDistance = Math.min(...centers.map((center) => labDistance(sample.lab, center)));
      const score = nearestDistance * nearestDistance * Math.sqrt(sample.weight);
      if (score > bestScore) {
        bestScore = score;
        bestSample = sample;
      }
    }
    if (bestScore <= 0.000001) break;
    centers.push({ ...bestSample.lab });
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const clusters = assignColorClusters(prepared, centers);
    if (clusters.length === 0) break;
    centers.splice(0, centers.length, ...clusters.map((cluster) => cluster.lab));
  }

  return assignColorClusters(prepared, centers);
}

function robustWeightedMean(samples: WeightedRgbSample[]): RgbSample | null {
  let totalWeight = 0;
  const total = { r: 0, g: 0, b: 0 };
  for (const sample of samples) {
    const weight = analysisWeight(sample);
    if (weight <= 0) continue;
    totalWeight += weight;
    total.r += sample.r * weight;
    total.g += sample.g * weight;
    total.b += sample.b * weight;
  }
  if (totalWeight <= 0) return null;
  return {
    r: total.r / totalWeight,
    g: total.g / totalWeight,
    b: total.b / totalWeight,
  };
}

function pickAmbientCluster(clusters: ColorCluster[]): RgbSample | null {
  let bestCluster: ColorCluster | null = null;
  let bestScore = -1;
  for (const cluster of clusters) {
    const chroma = Math.sqrt(cluster.lab.a * cluster.lab.a + cluster.lab.b * cluster.lab.b);
    const lumaPenalty = 1 - Math.min(0.46, Math.abs(cluster.brightness - 0.58) * 0.72);
    const saturationPenalty = 1 - clamp((cluster.saturation - 0.42) * 0.85, 0, 0.42);
    const chromaPenalty = 1 - clamp((chroma - 0.12) * 1.8, 0, 0.35);
    const score = cluster.weight * lumaPenalty * saturationPenalty * chromaPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestCluster = cluster;
    }
  }
  return bestCluster ? { r: bestCluster.r, g: bestCluster.g, b: bestCluster.b } : null;
}

function blendColor(base: RgbSample, target: RgbSample, amount: number): RgbSample {
  const t = clamp(amount, 0, 1);
  return {
    r: base.r + (target.r - base.r) * t,
    g: base.g + (target.g - base.g) * t,
    b: base.b + (target.b - base.b) * t,
  };
}

function isPointExcluded(point: SamplePoint, exclusions: SamplingExclusionRect[]): boolean {
  return exclusions.some((rect) =>
    point.x >= rect.xMin &&
    point.x <= rect.xMax &&
    point.y >= rect.yMin &&
    point.y <= rect.yMax,
  );
}

function clampRect(rect: SamplingExclusionRect): SamplingExclusionRect {
  return {
    xMax: clamp(rect.xMax, 0, 1),
    xMin: clamp(rect.xMin, 0, 1),
    yMax: clamp(rect.yMax, 0, 1),
    yMin: clamp(rect.yMin, 0, 1),
  };
}

function avoidExclusion(point: SamplePoint, fallback: SamplePoint, exclusions: SamplingExclusionRect[]): SamplePoint {
  if (!isPointExcluded(point, exclusions)) return point;
  const candidates: SamplePoint[] = [
    fallback,
    { x: point.x, y: 0.5 },
    { x: 0.5, y: point.y },
    { x: 0.5, y: 0.5 },
    { x: clamp(point.x, 0.18, 0.82), y: clamp(point.y, 0.18, 0.68) },
  ];
  return candidates.find((candidate) => !isPointExcluded(candidate, exclusions)) || { x: 0.5, y: 0.5 };
}

function filterExclusions(points: SamplePoint[], exclusions: SamplingExclusionRect[]): SamplePoint[] {
  return points.filter((point) => !isPointExcluded(point, exclusions));
}

function limitColorDrift(base: RgbSample, target: RgbSample, maxDistance: number): RgbSample {
  const distance = labDistance(rgbToOklab(base), rgbToOklab(target));
  if (distance <= maxDistance || distance <= 0.0001) return target;
  return blendColor(base, target, maxDistance / distance);
}

function analyzeVisionSamples(
  globalSamples: WeightedRgbSample[],
  localSamples: WeightedRgbSample[],
  colorStopSamples: RgbSample[],
): VisualSample | null {
  const globalAmbient =
    pickAmbientCluster(weightedKMeans(globalSamples)) ||
    robustWeightedMean(globalSamples) ||
    robustWeightedMean(localSamples);
  if (!globalAmbient) return null;

  const localMean = robustWeightedMean(localSamples) || globalAmbient;
  const localSaturation = colorSaturation(localMean);
  const localConfidence = clamp(0.34 + Math.min(localSamples.length, 36) / 36 * 0.22 - Math.max(0, localSaturation - 0.5) * 0.28, 0.24, 0.56);
  const limitedLocal = limitColorDrift(globalAmbient, localMean, 0.11);
  const ambient = blendColor(globalAmbient, limitedLocal, localConfidence * 0.42);
  const colorStops = colorStopSamples.map((stop) => {
    const limitedStop = limitColorDrift(ambient, stop, 0.16);
    return sampleToHex(blendColor(ambient, limitedStop, 0.28 + localConfidence * 0.34));
  });
  const brightness = colorBrightness(ambient);
  const saturation = colorSaturation(ambient);

  return {
    ...ambient,
    brightness,
    confidence: localConfidence,
    colorStops,
    saturation,
    warmth: colorWarmth(ambient),
  };
}

function normalizeAssetPreviewPath(path: string): string {
  if (!path) return '';
  const cleanPath = path.replace(/\\/g, '/');
  if (cleanPath.startsWith('asset://') || cleanPath.startsWith('http://') || cleanPath.startsWith('https://') || cleanPath.startsWith('data:')) {
    return cleanPath;
  }
  if (cleanPath.startsWith('file:///')) {
    return cleanPath.replace('file:///', 'asset://localhost/');
  }
  if (/^[a-zA-Z]:\//.test(cleanPath) || cleanPath.startsWith('/')) {
    return encodeURI(`asset://localhost/${cleanPath}`);
  }
  return cleanPath;
}

async function loadImageElement(path: string): Promise<HTMLImageElement | null> {
  const url = normalizeAssetPreviewPath(path);
  if (!url) return null;
  const cached = imageElementCache.get(url);
  if (cached) return cached;

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  imageElementCache.set(url, promise);
  return promise;
}

function createSamplingPoints(center: SamplePoint): SamplePoint[] {
  const offsetX = 0.045;
  const offsetY = 0.085;
  return [
    { x: clamp(center.x - offsetX, 0, 1), y: center.y },
    { x: clamp(center.x + offsetX, 0, 1), y: center.y },
    { x: center.x, y: clamp(center.y - offsetY, 0, 1) },
    { x: center.x, y: clamp(center.y + offsetY, 0, 1) },
  ];
}

function createGridSamplingPoints(columns: number, rows: number): SamplePoint[] {
  const points: SamplePoint[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      points.push({
        x: (column + 0.5) / columns,
        y: (row + 0.5) / rows,
      });
    }
  }
  return points;
}

function createLocalSamplingPoints(center: SamplePoint): SamplePoint[] {
  const points: SamplePoint[] = [];
  const columns = 5;
  const rows = 5;
  const spanX = 0.18;
  const spanY = 0.26;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = center.x + (column / (columns - 1) - 0.5) * spanX;
      const y = center.y + (row / (rows - 1) - 0.5) * spanY;
      points.push({ x: clamp(x, 0, 1), y: clamp(y, 0, 1) });
    }
  }
  return [...points, ...createSamplingPoints(center)];
}

function createColorStopSamplingPoints(center: SamplePoint): SamplePoint[] {
  const offsetX = 0.055;
  const offsetY = 0.095;
  return [
    { x: clamp(center.x - offsetX, 0, 1), y: clamp(center.y - offsetY, 0, 1) },
    { x: clamp(center.x + offsetX, 0, 1), y: clamp(center.y - offsetY, 0, 1) },
    { x: clamp(center.x - offsetX, 0, 1), y: clamp(center.y + offsetY, 0, 1) },
    { x: clamp(center.x + offsetX, 0, 1), y: clamp(center.y + offsetY, 0, 1) },
  ];
}

function createVisionSamplingGroups(center: SamplePoint, exclusions: SamplingExclusionRect[]): VisionSamplingGroups {
  const globalPoints = filterExclusions(createGridSamplingPoints(12, 8), exclusions);
  const localPoints = filterExclusions(createLocalSamplingPoints(center), exclusions);
  const colorStopPoints = createColorStopSamplingPoints(center)
    .map((point) => avoidExclusion(point, center, exclusions));
  return {
    all: [...globalPoints, ...localPoints, ...colorStopPoints],
    colorStopStartIndex: globalPoints.length + localPoints.length,
    globalCount: globalPoints.length,
    localStartIndex: globalPoints.length,
  };
}

async function sampleImageAtPoints(imagePath: string, points: SamplePoint[]): Promise<Array<{ r: number; g: number; b: number }> | null> {
  const img = await loadImageElement(imagePath);
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(img, 0, 0);

  return points.map((point) => {
    const px = clamp(Math.round(point.x * Math.max(0, img.naturalWidth - 1)), 0, Math.max(0, img.naturalWidth - 1));
    const py = clamp(Math.round(point.y * Math.max(0, img.naturalHeight - 1)), 0, Math.max(0, img.naturalHeight - 1));
    const data = context.getImageData(px, py, 1, 1).data;
    return { r: data[0], g: data[1], b: data[2] };
  });
}

function computeTimelineSceneStateAtTime(sceneData: TimelineScene, anchorTime: number) {
  const characters = new Map<string, any>();
  let dialogue: any = null;
  const { background, environmentLayers } = reconstructEnvironmentAtTime(
    sceneData as EnvironmentSamplingScene,
    anchorTime,
  );

  for (const action of sceneData.timeline) {
    if ((action.time || 0) > anchorTime) break;
    const p = action.params || {};
    switch (action.action) {
      case 'setBackground':
      case 'transformBackground':
      case 'removeBackground':
      case 'setEnvironmentLayer':
      case 'transformEnvironmentLayer':
      case 'removeEnvironmentLayer':
        break;
      case 'addCharacter': {
        const startTime = action.time || 0;
        const duration = p.duration ?? p.enterDuration ?? 0.8;
        const targetOpacity = p.opacity ?? 1;
        let currentOpacity = targetOpacity;
        const hasEntrance = p.enter !== 'none' && (
          (p.enter && p.enter !== 'none') ||
          p.duration !== undefined ||
          p.enterDuration !== undefined
        );

        if (hasEntrance && anchorTime < startTime + duration) {
          const progress = Math.max(0, (anchorTime - startTime) / duration);
          currentOpacity = progress * targetOpacity;
        }

        characters.set(p.id, {
          model: p.model,
          config: p,
          motion: null,
          expression: null,
          lookAt: null,
          position: p.position,
          scale: p.scale,
          rotation: p.rotation,
          opacity: currentOpacity,
          z: p.z ?? 0,
        });
        break;
      }
      case 'moveCharacter':
      case 'transformCharacter': {
        const startTime = action.time || 0;
        const duration = p.duration ?? 1;
        const entry = characters.get(p.id);
        if (!entry) break;
        if (anchorTime >= startTime + duration) {
          if (p.position !== undefined) entry.position = p.position;
          if (p.scale !== undefined) entry.scale = p.scale;
          if (p.rotation !== undefined) entry.rotation = p.rotation;
          if (p.opacity !== undefined) entry.opacity = p.opacity;
          if (p.z !== undefined) entry.z = p.z;
        } else if (anchorTime > startTime) {
          const progress = duration > 0 ? (anchorTime - startTime) / duration : 1;
          if (p.position !== undefined && entry.position !== undefined) {
            entry.position = [
              entry.position[0] + (p.position[0] - entry.position[0]) * progress,
              entry.position[1] + (p.position[1] - entry.position[1]) * progress,
            ];
          }
          if (p.scale !== undefined && entry.scale !== undefined) {
            entry.scale += (p.scale - entry.scale) * progress;
          }
          if (p.rotation !== undefined && entry.rotation !== undefined) {
            entry.rotation += (p.rotation - entry.rotation) * progress;
          }
          if (p.opacity !== undefined && entry.opacity !== undefined) {
            entry.opacity += (p.opacity - entry.opacity) * progress;
          }
          if (p.z !== undefined && entry.z !== undefined) {
            entry.z += (p.z - entry.z) * progress;
          }
        }
        break;
      }
      case 'removeCharacter': {
        const startTime = action.time || 0;
        const duration = p.duration ?? p.exitDuration ?? 0.6;
        if (p.exit === 'fadeOut' || (p.exit && p.exit !== 'none')) {
          if (anchorTime >= startTime && anchorTime < startTime + duration) {
            const progress = Math.max(0, (anchorTime - startTime) / duration);
            const entry = characters.get(p.id);
            if (entry) entry.opacity = (1 - progress) * (entry.opacity ?? 1);
          } else if (anchorTime >= startTime + duration) {
            characters.delete(p.id);
          }
        } else {
          characters.delete(p.id);
        }
        break;
      }
      case 'playMotion':
        if (characters.has(p.id)) {
          characters.get(p.id).motion = {
            key: p.motion,
            priority: p.priority,
            time: action.time,
            duration: p.duration,
            loop: p.loop === true,
          };
        }
        break;
      case 'setExpression':
        if (characters.has(p.id)) {
          characters.get(p.id).expression = {
            key: p.expression,
            time: action.time,
          };
        }
        break;
      case 'characterLookAt':
        if (characters.has(p.id)) {
          characters.get(p.id).lookAt = p;
        }
        break;
      case 'dialogue': {
        const startTime = action.time || 0;
        const duration = p.duration ?? 3;
        if (anchorTime >= startTime) {
          dialogue = { ...p, startTime, duration, _id: action._id };
        }
        break;
      }
    }
  }

  return { characters, background, environmentLayers, dialogue };
}

function resolveCharacterSamplingPoint(sceneData: TimelineScene, anchorTime: number, charId?: string): SamplePoint {
  if (!charId) {
    return { x: 0.5, y: 0.62 };
  }

  const sceneState = computeTimelineSceneStateAtTime(sceneData, anchorTime);
  const characterState = sceneState.characters.get(charId);
  const position = Array.isArray(characterState?.position) ? characterState.position : null;
  if (!position || typeof position[0] !== 'number' || typeof position[1] !== 'number') {
    return { x: 0.5, y: 0.62 };
  }

  return {
    x: clamp(position[0], 0.05, 0.95),
    y: clamp(position[1] - 0.08, 0.12, 0.94),
  };
}

function resolveSamplingImages(sceneData: TimelineScene, anchorTime: number): WeightedEnvironmentImage[] {
  const sceneState = computeTimelineSceneStateAtTime(sceneData, anchorTime);

  if (sceneState.background?.images?.length) {
    return sceneState.background.images
      .filter((entry: EnvironmentLayerRenderImage) => entry.image)
      .map((entry: EnvironmentLayerRenderImage) => ({ image: entry.image, weight: entry.weight ?? 1 }));
  }

  const visibleLayers = [...sceneState.environmentLayers.values()]
    .filter((layer) => layer.images?.length)
    .sort((left, right) => (right.z ?? 0) - (left.z ?? 0));
  const topLayer = visibleLayers[0];

  if (!topLayer) return [];

  return topLayer.images
    .filter((entry: EnvironmentLayerRenderImage) => entry.image)
    .map((entry: EnvironmentLayerRenderImage) => ({ image: entry.image, weight: entry.weight ?? 1 }));
}

function createTextLayerExclusion(params: Record<string, any>): SamplingExclusionRect {
  const position = Array.isArray(params.position) ? params.position : [0.5, 0.5];
  const scale = typeof params.scale === 'number' ? params.scale : 1;
  const fontSize = typeof params.fontSize === 'number' ? params.fontSize : 48;
  const width = clamp(((params.wordWrapWidth ?? 720) / 1920) * scale, 0.14, 0.72);
  const height = clamp((fontSize * 3.2 * scale) / 1080, 0.08, 0.3);
  return clampRect({
    xMax: position[0] + width * 0.5,
    xMin: position[0] - width * 0.5,
    yMax: position[1] + height * 0.5,
    yMin: position[1] - height * 0.5,
  });
}

function resolveTextExclusionRects(sceneData: TimelineScene, anchorTime: number): SamplingExclusionRect[] {
  const sceneState = computeTimelineSceneStateAtTime(sceneData, anchorTime);
  const exclusions: SamplingExclusionRect[] = [];

  if (sceneState.dialogue) {
    const position = sceneState.dialogue.position || 'bottom';
    if (position === 'top') {
      exclusions.push({ xMin: 0, xMax: 1, yMin: 0, yMax: 0.34 });
    } else if (position === 'center') {
      exclusions.push({ xMin: 0.06, xMax: 0.94, yMin: 0.3, yMax: 0.7 });
    } else {
      exclusions.push({ xMin: 0, xMax: 1, yMin: 0.66, yMax: 1 });
    }
  }

  const activeTextLayers = new Map<string, Record<string, any>>();
  for (const action of sceneData.timeline) {
    const actionTime = action.time ?? 0;
    if (actionTime > anchorTime) break;
    const params = action.params || {};
    if (action.action === 'addTextLayer' && params.id) {
      const duration = typeof params.duration === 'number' ? params.duration : Number.POSITIVE_INFINITY;
      if (anchorTime <= actionTime + duration) {
        activeTextLayers.set(params.id, { ...params });
      }
    }
    if (action.action === 'transformTextLayer' && params.id && activeTextLayers.has(params.id)) {
      activeTextLayers.set(params.id, { ...activeTextLayers.get(params.id), ...params });
    }
    if (action.action === 'removeTextLayer' && params.id) {
      activeTextLayers.delete(params.id);
    }
  }

  for (const params of activeTextLayers.values()) {
    exclusions.push(createTextLayerExclusion(params));
  }

  return exclusions.map(clampRect);
}

async function sampleVisualEnvironment(sceneData: TimelineScene, anchorTime: number, charId?: string): Promise<VisualSample | null> {
  const images = resolveSamplingImages(sceneData, anchorTime);
  if (images.length === 0) return null;

  const exclusions = resolveTextExclusionRects(sceneData, anchorTime);
  const groups = createVisionSamplingGroups(resolveCharacterSamplingPoint(sceneData, anchorTime, charId), exclusions);
  const globalSamples: WeightedRgbSample[] = [];
  const localSamples: WeightedRgbSample[] = [];
  const stopTotals = Array.from({ length: 4 }, () => ({ r: 0, g: 0, b: 0 }));
  const stopWeights = Array.from({ length: 4 }, () => 0);
  let totalWeight = 0;

  for (const image of images) {
    const sampledPoints = await sampleImageAtPoints(image.image, groups.all);
    if (!sampledPoints) continue;
    const weight = Math.max(0.001, image.weight || 1);
    totalWeight += weight;

    for (let index = 0; index < groups.globalCount; index += 1) {
      const sample = sampledPoints[index];
      if (sample) globalSamples.push({ ...sample, weight });
    }

    for (let index = groups.localStartIndex; index < groups.colorStopStartIndex; index += 1) {
      const sample = sampledPoints[index];
      if (sample) localSamples.push({ ...sample, weight });
    }

    for (let index = 0; index < 4; index += 1) {
      const stop = sampledPoints[groups.colorStopStartIndex + index];
      if (!stop) continue;
      stopTotals[index].r += stop.r * weight;
      stopTotals[index].g += stop.g * weight;
      stopTotals[index].b += stop.b * weight;
      stopWeights[index] += weight;
    }
  }

  if (totalWeight <= 0) return null;

  const colorStopSamples = stopTotals.map((stop, index) => {
    const divisor = Math.max(stopWeights[index], 0.0001);
    return {
      r: stop.r / divisor,
      g: stop.g / divisor,
      b: stop.b / divisor,
    };
  });

  return analyzeVisionSamples(globalSamples, localSamples, colorStopSamples);
}

function buildGroundingPreset(sample: VisualSample | null, baseParams: Record<string, any>): Record<string, any> {
  if (!sample) {
    return {
      ...baseParams,
      slot: 'grounding',
      recipeId: 'builtin:ground-shadow-soft',
      mode: 'latching',
    };
  }

  const darkness = 1 - sample.brightness;
  return {
    ...baseParams,
    slot: 'grounding',
    recipeId: 'builtin:ground-shadow-soft',
    mode: 'latching',
    intensity: roundToStep(clamp(0.86 + darkness * 0.3, 0.72, 1.18)),
    blend: roundToStep(clamp(0.44 + darkness * 0.14 + sample.saturation * 0.06, 0.36, 0.7)),
    contamination: roundToStep(clamp(0.24 + darkness * 0.16 + sample.saturation * 0.08, 0.18, 0.56)),
    warmth: roundToStep(clamp(sample.warmth * 0.42, -0.4, 0.4)),
  };
}

function buildIntegrationPreset(sample: VisualSample | null, baseParams: Record<string, any>): Record<string, any> {
  if (!sample) {
    return {
      ...baseParams,
      slot: 'integration',
      recipeId: 'builtin:integration-soft-warm',
      mode: 'latching',
    };
  }

  const recipeId = sample.warmth < -0.12
    ? 'builtin:integration-soft-cool'
    : sample.warmth > 0.14
      ? 'builtin:integration-soft-warm'
      : 'builtin:integration-soft';
  const confidence = sample.confidence ?? 0.4;
  const saturationRisk = clamp((sample.saturation - 0.42) / 0.36, 0, 1);

  return {
    ...baseParams,
    slot: 'integration',
    recipeId,
    mode: 'latching',
    color: sampleToHex(sample),
    colorStops: sample.colorStops,
    colorBlendMode: 'multiply',
    intensity: roundToStep(clamp(0.72 + confidence * 0.18 - saturationRisk * 0.06, 0.62, 0.92)),
    warmth: roundToStep(clamp(sample.warmth * 0.48, -0.42, 0.42)),
    blend: roundToStep(clamp(0.28 + confidence * 0.14 + (1 - sample.brightness) * 0.04, 0.24, 0.5)),
    contamination: roundToStep(clamp(0.1 + confidence * 0.11 + sample.saturation * 0.035 - saturationRisk * 0.11, 0.08, 0.3)),
  };
}

export function isPrimaryVisualIntent(actionType: string, params?: Record<string, any>): boolean {
  if (actionType === 'setCompositeRecipe' && (params?.slot === 'grounding' || params?.slot === 'integration')) {
    return true;
  }
  return false;
}

export function getPrimaryVisualIntentLabel(actionType: string, params?: Record<string, any>): string | null {
  if (actionType === 'setCompositeRecipe' && params?.slot === 'grounding') return '角色明暗融入';
  if (actionType === 'setCompositeRecipe' && params?.slot === 'integration') return '角色色彩融入';
  return null;
}

export async function recommendVisualIntentInitialParams({
  sceneData,
  actionType,
  anchorTime,
  baseParams = {},
  scopeCharId,
}: VisualIntentPresetRequest): Promise<Record<string, any>> {
  const slot = String(baseParams.slot || '');

  if (actionType === 'setCompositeRecipe' && slot === 'grounding') {
    const sample = await sampleVisualEnvironment(sceneData, anchorTime, scopeCharId);
    return buildGroundingPreset(sample, baseParams);
  }

  if (actionType === 'setCompositeRecipe' && slot === 'integration') {
    const sample = await sampleVisualEnvironment(sceneData, anchorTime, scopeCharId);
    return buildIntegrationPreset(sample, baseParams);
  }

  return baseParams;
}
