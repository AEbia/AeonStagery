import type { CameraParams } from '../../api/types/semantic-scene';
import { DEFAULT_VIDEO_FORMAT } from '../../api/types/video-format';
import { prepareCameraStateResolver, prepareCameraZoomResolver } from '../../engine/CameraStateResolver';
import { prepareEnvironmentResolver } from '../../engine/EnvironmentLayerRuntime';
import { hasUncoveredEnvironmentFrame, isValidImageSize } from '../../engine/EnvironmentFrameCoverage';
import type { RuntimeTimelineAction } from '../../engine/RuntimeTimelineScene';
import { lowerCamera, lowerEnvironmentLayer } from './SceneStatementCompiler';
import { lowerCameraPropertyTracks, type CameraProperty } from './CameraPropertyTracks';
import { sceneStatementDefinitionRegistry } from './SceneStatementDefinitionRegistry';
import type { SemanticSceneValidationOptions, SemanticValidationIssue, StatementValidationContext } from './SemanticSceneValidator';

function cameraDuration(params: CameraParams): number {
  if (params.mode === 'path') {
    const last = Math.max(0, ...params.keyframes.map(frame => frame.time));
    return last * (params.loop || params.repeat === -1 ? 1 : 1 + (params.repeat ?? 0));
  }
  return params.mode === 'follow' || params.mode === 'shake' || params.mode === 'hitchcock'
    ? 0 : params.durationSeconds ?? 1;
}

/** Character anchors require live geometry; never substitute a guessed position. */
function preparePositionKnownness(contexts: readonly StatementValidationContext[]): (time: number) => boolean {
  const writers: Array<{ start: number; sample: (time: number) => boolean }> = [];
  let previous = (_time: number): boolean => true;
  for (const { statement } of contexts) {
    if (statement.type !== 'camera') continue;
    const params = statement.params;
    let sample: (time: number) => boolean;
    if ((params.mode === 'follow' && params.operation === 'start') || (params.mode === 'focus' && params.target)) {
      sample = () => false;
    } else if (lowerCameraPropertyTracks(params).includes('position')) {
      // Capture knownness at the actual handoff, never at a displaced
      // predecessor's nominal completion time.
      const knownAtStart = previous(statement.time);
      if (params.mode === 'path') {
        const first = [...params.keyframes].sort((a, b) => a.time - b.time).find(frame => frame.position);
        const duration = cameraDuration({ ...params, repeat: 0, loop: false });
        const plays = params.loop || params.repeat === -1 ? Infinity : 1 + (params.repeat ?? 0);
        sample = time => {
          if (knownAtStart) return true;
          let local = time - statement.time;
          if (duration > 0 && local >= duration) {
            if (local < duration * plays) {
              const cycle = Math.floor(local / duration);
              local %= duration;
              if (params.yoyo && cycle % 2 === 1) local = duration - local;
            } else local = params.yoyo && plays % 2 === 0 ? 0 : duration;
          }
          return first !== undefined && local >= first.time;
        };
      } else {
        const end = statement.time + cameraDuration(params);
        sample = time => knownAtStart || time >= end;
      }
    } else continue;
    writers.push({ start: statement.time, sample });
    previous = sample;
  }
  return time => {
    let low = 0;
    let high = writers.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (writers[middle].start <= time) low = middle + 1;
      else high = middle;
    }
    return low === 0 || writers[low - 1].sample(time);
  };
}

export function collectCameraCoverageIssues(
  contexts: readonly StatementValidationContext[],
  options?: SemanticSceneValidationOptions,
  sceneDuration = 0,
): SemanticValidationIssue[] {
  const issues: SemanticValidationIssue[] = [];
  for (const issue of sampleCameraCoverage(contexts, options, sceneDuration)) {
    if (issue) issues.push(issue);
  }
  return issues;
}

/** Bound renderer work to short batches, and stop obsolete validation runs. */
export async function collectCameraCoverageIssuesAsync(
  contexts: readonly StatementValidationContext[],
  options: SemanticSceneValidationOptions,
  sceneDuration: number,
  isCurrent: () => boolean,
): Promise<SemanticValidationIssue[]> {
  const issues: SemanticValidationIssue[] = [];
  let batchStart = performance.now();
  const samples = sampleCameraCoverage(contexts, options, sceneDuration);
  while (isCurrent()) {
    const sample = samples.next();
    if (sample.done) return isCurrent() ? issues : [];
    if (sample.value) issues.push(sample.value);
    if (performance.now() - batchStart >= 4) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (!isCurrent()) return [];
      batchStart = performance.now();
    }
  }
  return [];
}

function* sampleBoundaryTimes(start: number, end: number, inclusive: boolean, params: CameraParams): Generator<number> {
  yield start;
  if (params.mode === 'path') {
    const times = params.keyframes.map(frame => frame.time).sort((a, b) => a - b);
    const duration = times[times.length - 1] ?? 0;
    const plays = duration <= 0 ? 1
      : params.loop || params.repeat === -1 ? Infinity : 1 + (params.repeat ?? 0);
    const reflected = times.map(time => duration - time).reverse();
    // Generate occurrences lazily so long loops remain cancellable between samples.
    cycles: for (let cycle = 0; cycle < plays && start + cycle * duration < end; cycle++) {
      const offsets = params.yoyo && cycle % 2 === 1 ? reflected : times;
      for (const offset of offsets) {
        const time = start + cycle * duration + offset;
        if (time >= end) break cycles;
        yield time;
      }
    }
  }
  if (inclusive) yield end;
}

function* sampleTimes(start: number, end: number, inclusive: boolean, fps: number, params: CameraParams): Generator<number> {
  const belongs = (time: number) => time >= start && (time < end || (inclusive && time === end));
  if (!belongs(start)) return;
  const special = sampleBoundaryTimes(start, end, inclusive, params);
  let next = special.next();
  let frame = Math.ceil(start * fps);
  let last = -Infinity;
  while (!next.done || belongs(frame / fps)) {
    const time = Math.min(next.done ? Infinity : next.value, belongs(frame / fps) ? frame / fps : Infinity);
    if (time !== last) yield time;
    last = time;
    if (!next.done && next.value === time) next = special.next();
    if (frame / fps === time) frame++;
  }
}

function* sampleCameraCoverage(
  contexts: readonly StatementValidationContext[],
  options?: SemanticSceneValidationOptions,
  sceneDuration = 0,
): Generator<SemanticValidationIssue | undefined> {
  // Without texture dimensions, a cover-fit image can extend arbitrarily far
  // beyond the viewport. Missing metadata must not turn that into a warning.
  const imageSize = options?.environmentImageSize;
  if (!imageSize) return;
  const reference = options?.cameraReferenceSize ?? DEFAULT_VIDEO_FORMAT;
  if (!isValidImageSize(reference)) return;
  const fps = options?.cameraSampleFps ?? DEFAULT_VIDEO_FORMAT.fps;
  if (!Number.isFinite(fps) || fps <= 0) return;
  const ordered = [...contexts].sort((a, b) => a.statement.time - b.statement.time
    || a.sourceOrder - b.sourceOrder || a.companionOrder - b.companionOrder);
  const timeline: RuntimeTimelineAction[] = [];
  for (const context of ordered) {
    const statement = context.statement;
    const lowered = statement.type === 'camera' ? lowerCamera(statement.params)
      : statement.type === 'environmentLayer' ? lowerEnvironmentLayer(statement.params) : [];
    for (const action of lowered) {
      const runtime = { _id: statement.id, time: statement.time, action: action.action, params: { ...action.params } };
      timeline.push(runtime);
    }
  }
  const script = { sceneId: 'coverage', meta: { title: 'Coverage' }, timeline };
  const cameraTimeline = timeline.filter(action => action.action.startsWith('camera'));
  const resolveCamera = prepareCameraStateResolver(cameraTimeline, {
    compiledChannelOwnership: true, resolveZoomAtTime: prepareCameraZoomResolver(cameraTimeline),
  });
  const resolveEnvironment = prepareEnvironmentResolver(script);
  const positionIsKnown = preparePositionKnownness(ordered);
  const cameras = ordered.filter(context => context.statement.type === 'camera');
  const handoffs: Partial<Record<CameraProperty, number>>[] = new Array(cameras.length);
  const nextWriter: Partial<Record<CameraProperty, number>> = {};
  for (let index = cameras.length - 1; index >= 0; index--) {
    handoffs[index] = { ...nextWriter };
    const { statement } = cameras[index];
    if (statement.type !== 'camera') continue;
    for (const property of lowerCameraPropertyTracks(statement.params)) nextWriter[property] = statement.time;
    if (statement.params.mode === 'follow' && statement.params.operation === 'start') nextWriter.position = statement.time;
  }
  const sceneEnd = ordered.reduce((end, { statement }) => Math.max(end, statement.time
    + sceneStatementDefinitionRegistry.temporalExtent(statement)), sceneDuration);
  for (const [index, context] of cameras.entries()) {
    if (context.statement.type !== 'camera') continue;
    const params = context.statement.params;
    if (params.mode === 'follow' || params.mode === 'hitchcock' || params.mode === 'shake') continue;
    const start = context.statement.time;
    const duration = params.mode === 'path' && (params.loop || params.repeat === -1)
      ? Math.max(cameraDuration(params), sceneEnd - start) : cameraDuration(params);
    // A zoom writer must not truncate a still-running position/rotation path.
    const ends = lowerCameraPropertyTracks(params).map(property => {
      const completion = start + duration;
      const handoff = handoffs[index][property] ?? Infinity;
      return { time: Math.min(completion, handoff), inclusive: completion < handoff };
    });
    if (ends.length === 0) continue;
    const end = Math.max(...ends.map(boundary => boundary.time));
    const inclusive = ends.some(boundary => boundary.time === end && boundary.inclusive);
    if (end < start) continue;
    for (const time of sampleTimes(start, end, inclusive, fps, params)) {
      if (!positionIsKnown(time)) {
        yield undefined;
        continue;
      }
      const camera = resolveCamera(time);
      const layers = resolveEnvironment(time).environmentLayers;
      if (hasUncoveredEnvironmentFrame(layers.values(), camera, reference, imageSize) !== true) {
        yield undefined;
        continue;
      }
      yield {
        severity: 'warning',
        message: `镜头在 ${Math.round(time * 100) / 100} 秒时，所有可见环境图层（${[...layers.keys()].map(id => `「${id}」`).join('、')}）合并后仍未覆盖完整画面，边缘会出现黑边；请放大 zoom、扩大图层 scale 或调整构图。`,
        actionId: context.actionId,
        actionType: context.actionType,
        code: 'semantic.camera.black-edge',
        location: `${context.location}.params`,
      };
      break;
    }
  }
}
