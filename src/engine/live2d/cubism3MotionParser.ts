import type {
  CharacterMotionOutput,
  CustomMotionKeyframe,
  CustomMotionSegment,
  CustomMotionTrack,
} from '../../api/types/semantic-scene';

/** Motion3 segment tags from the Cubism 3/4/5 JSON format. */
const LINEAR = 0;
const BEZIER = 1;
const STEPPED = 2;
const INVERSE_STEPPED = 3;

export interface Cubism3MotionParserOptions {
  readonly derivedFromKey?: string;
}

export interface Cubism3MotionParseResult {
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

function finiteNonNegative(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  const result = finiteNumber(value, label);
  if (result < 0) throw new Error(`Motion3 ${label} must be non-negative`);
  return result;
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
  const motionFadeInSeconds = finiteNonNegative(meta.FadeInTime, 'Meta.FadeInTime', 0);
  const fadeOutSeconds = finiteNonNegative(meta.FadeOutTime, 'Meta.FadeOutTime', 0);
  const areBeziersRestricted = meta.AreBeziersRestricted === true;
  if (motionFadeInSeconds > duration) throw new Error('Motion3 Meta.FadeInTime cannot exceed duration');

  const tracks: CustomMotionTrack[] = [];
  const ignoredCurves: Array<{ target: string; id: string }> = [];
  const seen = new Set<string>();
  source.Curves.forEach((rawCurve, curveIndex) => {
    if (!rawCurve || typeof rawCurve !== 'object') throw new Error(`Motion3 curve ${curveIndex} must be an object`);
    const curve = rawCurve as Motion3Curve;
    const target = typeof curve.Target === 'string' ? curve.Target : '';
    const id = typeof curve.Id === 'string' ? curve.Id : '';
    if (!target || !id) throw new Error(`Motion3 curve ${curveIndex} requires Target and Id`);
    if (target !== 'Parameter') {
      ignoredCurves.push({ target, id });
      return;
    }
    if (seen.has(id)) throw new Error(`Motion3 contains duplicate Parameter curve ${id}`);
    seen.add(id);
    // Cubism's exported Motion3 files use -1 on a curve to mean "use the
    // motion-level fade". It is a sentinel, not a negative duration.
    const fadeInSeconds = curve.FadeInTime === undefined || curve.FadeInTime === -1
      ? undefined
      : finiteNonNegative(curve.FadeInTime, `curve ${curveIndex}.FadeInTime`, motionFadeInSeconds);
    if (fadeInSeconds !== undefined && fadeInSeconds > duration) {
      throw new Error(`Motion3 curve ${curveIndex}.FadeInTime cannot exceed duration`);
    }
    tracks.push({
      parameterId: id,
      ...(fadeInSeconds !== undefined ? { fadeInSeconds } : {}),
      keyframes: decodeCurve(curve, curveIndex, duration, areBeziersRestricted),
    });
  });

  if (tracks.length === 0) throw new Error('Motion3 contains no Parameter curves');
  return {
    motion: {
      kind: 'custom',
      durationSeconds: duration,
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
