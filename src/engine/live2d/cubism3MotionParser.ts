import type {
  CharacterMotionOutput,
  CustomMotionKeyframe,
  CustomMotionSegment,
  CustomMotionTrack,
} from '../../api/types/semantic-scene';
import { evaluateCustomMotionTrack } from './customMotion';

/** Motion3 segment tags from the Cubism 3/4/5 JSON format. */
const LINEAR = 0;
const BEZIER = 1;
const STEPPED = 2;
const INVERSE_STEPPED = 3;

export interface Cubism3MotionParserOptions {
  readonly derivedFromKey?: string;
  readonly fps?: number;
  readonly eyeBlinkParameterIds?: readonly string[];
  readonly lipSyncParameterIds?: readonly string[];
}

export interface Cubism3MotionParseResult {
  readonly sourceDurationSeconds: number;
  readonly motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  readonly ignoredCurves: readonly { target: string; id: string }[];
}

interface Motion3Meta {
  Duration?: unknown;
  FadeInTime?: unknown;
  FadeOutTime?: unknown;
  AreBeziersRestricted?: unknown;
}

interface Motion3Curve {
  Target?: unknown;
  Id?: unknown;
  Segments?: unknown;
  FadeInTime?: unknown;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Motion3 ${label} must be a finite number`);
  }
  return value;
}

function resolveFadeSeconds(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  const result = finiteNumber(value, label);
  // CubismMotion resolves negative motion-level fades to its 1s SDK default.
  return result < 0 ? 1 : result;
}

function segmentType(value: unknown, curveIndex: number): number {
  const type = finiteNumber(value, `curve ${curveIndex} segment type`);
  if (!Number.isInteger(type) || type < LINEAR || type > INVERSE_STEPPED) {
    throw new Error(`Motion3 curve ${curveIndex} has unsupported segment type ${String(value)}`);
  }
  return type;
}

function readSegments(curve: Motion3Curve, curveIndex: number): number[] {
  if (!Array.isArray(curve.Segments) || curve.Segments.length < 2) {
    throw new Error(`Motion3 curve ${curveIndex} must contain an initial time/value pair`);
  }
  return curve.Segments.map((value, index) => finiteNumber(value, `curve ${curveIndex} segment value ${index}`));
}

/**
 * Decode one Motion3 curve. The first two values are the initial point; every
 * following segment starts with a type tag and ends at a new time/value point.
 */
function decodeCurve(
  curve: Motion3Curve,
  curveIndex: number,
  duration: number,
  areBeziersRestricted: boolean,
): CustomMotionKeyframe[] {
  const values = readSegments(curve, curveIndex);
  const keyframes: CustomMotionKeyframe[] = [{ time: values[0], value: values[1] }];
  let offset = 2;

  while (offset < values.length) {
    const type = segmentType(values[offset], curveIndex);
    offset += 1;
    const current = keyframes[keyframes.length - 1];
    if (type === BEZIER) {
      if (offset + 5 >= values.length) throw new Error(`Motion3 curve ${curveIndex} has an incomplete Bezier segment`);
      const next = { time: values[offset + 4], value: values[offset + 5] };
      const span = next.time - current.time;
      const p1 = {
        time: areBeziersRestricted ? current.time + span / 3 : values[offset],
        value: values[offset + 1],
      };
      const p2 = {
        time: areBeziersRestricted ? current.time + (span * 2) / 3 : values[offset + 2],
        value: values[offset + 3],
      };
      offset += 6;
      if (p1.time < current.time || p2.time < p1.time || p2.time > next.time) {
        throw new Error(`Motion3 curve ${curveIndex} Bezier control point times are outside the segment`);
      }
      keyframes[keyframes.length - 1] = {
        ...current,
        segment: { type: 'bezier', controlPoints: [p1, p2] },
      };
      keyframes.push(next);
      continue;
    }

    if (offset + 1 >= values.length) throw new Error(`Motion3 curve ${curveIndex} has an incomplete segment`);
    const next = { time: values[offset], value: values[offset + 1] };
    offset += 2;
    const segment: CustomMotionSegment = type === LINEAR
      ? { type: 'linear' }
      : type === STEPPED
        ? { type: 'stepped' }
        : { type: 'inverseStepped' };
    keyframes[keyframes.length - 1] = { ...current, segment };
    keyframes.push(next);
  }

  if (keyframes.length < 2) {
    // A constant Motion3 curve is valid and must remain editable.
    keyframes.push({ time: duration, value: keyframes[0].value });
    keyframes[0] = { ...keyframes[0], segment: { type: 'linear' } };
  }
  for (let index = 0; index < keyframes.length; index++) {
    const keyframe = keyframes[index];
    if (keyframe.time < 0 || keyframe.time > duration) {
      throw new Error(`Motion3 curve ${curveIndex} keyframe time is outside the motion duration`);
    }
    if (index > 0 && keyframe.time <= keyframes[index - 1].time) {
      throw new Error(`Motion3 curve ${curveIndex} keyframe times must be strictly increasing`);
    }
  }
  return keyframes;
}

export function parseCubism3MotionJson(
  document: unknown,
  options: Cubism3MotionParserOptions = {},
): Cubism3MotionParseResult {
  if (!document || typeof document !== 'object') throw new Error('Motion3 document must be an object');
  const source = document as { Meta?: Motion3Meta; Curves?: unknown };
  const meta = source.Meta;
  if (!meta || typeof meta !== 'object') throw new Error('Motion3 document is missing Meta');
  if (!Array.isArray(source.Curves)) throw new Error('Motion3 document is missing Curves');

  const duration = finiteNumber(meta.Duration, 'Meta.Duration');
  if (duration <= 0) throw new Error('Motion3 Meta.Duration must be positive');
  const motionFadeInSeconds = resolveFadeSeconds(meta.FadeInTime, 'Meta.FadeInTime', 0);
  const fadeOutSeconds = resolveFadeSeconds(meta.FadeOutTime, 'Meta.FadeOutTime', 0);
  const areBeziersRestricted = meta.AreBeziersRestricted === true;

  const tracks: CustomMotionTrack[] = [];
  const effects = new Map<'EyeBlink' | 'LipSync', CustomMotionTrack>();
  const ignoredCurves: Array<{ target: string; id: string }> = [];
  const seen = new Set<string>();
  source.Curves.forEach((rawCurve, curveIndex) => {
    if (!rawCurve || typeof rawCurve !== 'object') throw new Error(`Motion3 curve ${curveIndex} must be an object`);
    const curve = rawCurve as Motion3Curve;
    const target = typeof curve.Target === 'string' ? curve.Target : '';
    const id = typeof curve.Id === 'string' ? curve.Id : '';
    if (!target || !id) throw new Error(`Motion3 curve ${curveIndex} requires Target and Id`);
    if (target === 'Model' && (id === 'EyeBlink' || id === 'LipSync')) {
      const ids = id === 'EyeBlink' ? options.eyeBlinkParameterIds : options.lipSyncParameterIds;
      if (ids?.length) {
        if (effects.has(id)) throw new Error(`Motion3 contains duplicate Model curve ${id}`);
        effects.set(id, { parameterId: id, keyframes: decodeCurve(curve, curveIndex, duration, areBeziersRestricted) });
        return;
      }
    }
    if (target !== 'Parameter') {
      ignoredCurves.push({ target, id });
      return;
    }
    if (seen.has(id)) throw new Error(`Motion3 contains duplicate Parameter curve ${id}`);
    seen.add(id);
    // Cubism's exported Motion3 files use -1 on a curve to mean "use the
    // motion-level fade". It is a sentinel, not a negative duration.
    const fadeInSeconds = curve.FadeInTime === undefined || finiteNumber(curve.FadeInTime, `curve ${curveIndex}.FadeInTime`) < 0
      ? undefined
      : resolveFadeSeconds(curve.FadeInTime, `curve ${curveIndex}.FadeInTime`, motionFadeInSeconds);
    tracks.push({
      parameterId: id,
      ...(fadeInSeconds !== undefined ? { fadeInSeconds } : {}),
      keyframes: decodeCurve(curve, curveIndex, duration, areBeziersRestricted),
    });
  });

  expandModelEffects(tracks, effects, options, duration);
  if (tracks.length === 0) throw new Error('Motion3 contains no Parameter curves');
  return {
    sourceDurationSeconds: duration,
    motion: {
      kind: 'custom',
      durationSeconds: Math.max(duration, motionFadeInSeconds, ...tracks.map((track) => track.fadeInSeconds ?? 0)),
      fadeInSeconds: motionFadeInSeconds,
      derivedFrom: {
        key: options.derivedFromKey ?? 'motion3',
        ...(meta.FadeInTime !== undefined ? { fadeInSeconds: motionFadeInSeconds } : {}),
        ...(meta.FadeOutTime !== undefined ? { fadeOutSeconds } : {}),
      },
      tracks,
    },
    ignoredCurves,
  };
}

/** Model effects compose with direct curves before their normal parameter fade. */
function expandModelEffects(
  tracks: CustomMotionTrack[],
  effects: ReadonlyMap<'EyeBlink' | 'LipSync', CustomMotionTrack>,
  options: Cubism3MotionParserOptions,
  duration: number,
): void {
  if (effects.size === 0) return;
  const fps = options.fps ?? 60;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Motion3 effect sampling fps must be finite and positive');
  const eyes = new Set(effects.has('EyeBlink') ? options.eyeBlinkParameterIds : []);
  const lips = new Set(effects.has('LipSync') ? options.lipSyncParameterIds : []);
  const affected = new Set([...eyes, ...lips]);
  const frameTimes = Array.from({ length: Math.floor(duration * fps) + 1 }, (_, frame) => frame / fps);
  if (frameTimes.at(-1)! < duration) frameTimes.push(duration);
  for (const id of affected) {
    const index = tracks.findIndex((track) => track.parameterId === id);
    const direct = tracks[index];
    const sources = [direct, eyes.has(id) ? effects.get('EyeBlink') : undefined,
      lips.has(id) ? effects.get('LipSync') : undefined].filter((track): track is CustomMotionTrack => track !== undefined);
    const { times, stepStarts, initialInverseStep } = effectSampleTimes(frameTimes, sources);
    const keyframes: CustomMotionKeyframe[] = times.map((time, frame) => {
      let value = direct ? evaluateCustomMotionTrack(direct, time)! : eyes.has(id) ? 1 : 0;
      if (eyes.has(id)) value *= evaluateCustomMotionTrack(effects.get('EyeBlink')!, time)!;
      if (lips.has(id)) value += evaluateCustomMotionTrack(effects.get('LipSync')!, time)!;
      const type = frame === 0 && initialInverseStep ? 'inverseStepped' : stepStarts.has(time) ? 'stepped' : 'linear';
      return { time, value, ...(frame < times.length - 1 ? { segment: { type } } : {}) };
    });
    const expanded: CustomMotionTrack = { ...(direct ?? { parameterId: id }), keyframes };
    if (index < 0) tracks.push(expanded);
    else tracks[index] = expanded;
  }
}

/** Keep discontinuities at their source times while sampling smooth composition. */
function effectSampleTimes(frameTimes: readonly number[], sources: readonly CustomMotionTrack[]): {
  times: number[];
  stepStarts: Set<number>;
  initialInverseStep: boolean;
} {
  const times = new Set(frameTimes);
  const jumps = new Set<number>();
  let initialInverseStep = false;
  for (const track of sources) {
    track.keyframes.forEach((point, index) => {
      times.add(point.time);
      const next = track.keyframes[index + 1];
      if (!next || point.value === next.value) return;
      if (point.segment?.type === 'stepped') jumps.add(next.time);
      else if (point.segment?.type === 'inverseStepped') {
        if (point.time === 0) initialInverseStep = true;
        else jumps.add(point.time);
      }
    });
  }
  const boundaries = [...times].sort((a, b) => a - b);
  const stepStarts = new Set<number>();
  for (let index = 1; index < boundaries.length; index++) {
    const time = boundaries[index];
    if (!jumps.has(time)) continue;
    const previous = boundaries[index - 1];
    // A sample just before the jump carries its left limit. A stepped segment
    // then reaches the exact jump time without interpolating across it. The
    // gap is a few floating-point units, so other smooth channels keep moving
    // throughout the preceding frame instead of being held for a full frame.
    const gap = Math.min((time - previous) / 2, Number.EPSILON * Math.max(1, time) * 4);
    const before = time - gap;
    const start = before > previous && before < time ? before : previous;
    times.add(start);
    stepStarts.add(start);
  }
  if (initialInverseStep) {
    // F0 itself retains the source value; every positive time sees the jump.
    const after = Math.min(boundaries[1] / 2, Number.EPSILON * 4);
    if (after > 0) times.add(after);
  }
  return { times: [...times].sort((a, b) => a - b), stepStarts, initialInverseStep };
}

export function parseCubism3MotionBuffer(
  buffer: ArrayBuffer,
  options: Cubism3MotionParserOptions = {},
): Cubism3MotionParseResult {
  const text = new TextDecoder().decode(buffer);
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid Motion3 JSON: ${String(error)}`);
  }
  return parseCubism3MotionJson(document, options);
}
