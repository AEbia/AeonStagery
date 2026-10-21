import type {
  CameraAnchorEvent,
  CameraAnchorSample,
  CameraAnchorTrajectory,
  CameraAnchorValidityInterval,
} from './CameraChannelEvaluator';
import type { CameraPosition } from './CameraStateResolver';
import { sampleCameraAnchorTrajectory } from './CameraChannelEvaluator';

export type PreparedCameraAnchorTrajectory = CameraAnchorTrajectory & {
  /** Changes whenever a preparation session publishes new content. */
  readonly revision: string | number;
};

export interface CameraAnchorCapture {
  readonly time: number;
  readonly characterId: string;
  readonly anchors: Readonly<Partial<Record<'origin' | 'head' | 'chest' | 'feet' | 'center', CameraPosition | null>>>;
}

export interface CameraAnchorPreparationInput {
  readonly revision: string | number;
  readonly cadenceSeconds: number;
  readonly captures: readonly CameraAnchorCapture[];
  readonly eventTimes?: readonly number[];
}

/** Reuse the evaluator's side-aware, validity-scoped interpolation for prepared tracks. */
export function samplePreparedCameraAnchorTrajectory(
  trajectory: PreparedCameraAnchorTrajectory,
  time: number,
  side: 'left' | 'right' = 'right',
): CameraPosition | null {
  return sampleCameraAnchorTrajectory(trajectory, time, side);
}

/** Build frozen evaluator-ready tracks from isolated post-frame geometry captures. */
export function prepareCameraAnchorTrajectories(
  input: CameraAnchorPreparationInput,
): readonly PreparedCameraAnchorTrajectory[] {
  const grouped = new Map<string, CameraAnchorCapture[]>();
  for (const capture of input.captures) {
    const list = grouped.get(capture.characterId) ?? [];
    list.push(capture);
    grouped.set(capture.characterId, list);
  }

  const prepared: PreparedCameraAnchorTrajectory[] = [];
  for (const [characterId, captures] of grouped) {
    captures.sort((a, b) => a.time - b.time);
    for (const part of ['origin', 'head', 'chest', 'feet', 'center'] as const) {
      const valid = captures.filter((capture) => capture.anchors[part] !== null && capture.anchors[part] !== undefined);
      if (!valid.length) continue;
      const samples: CameraAnchorSample[] = valid.map((capture) => Object.freeze({
        time: capture.time,
        position: Object.freeze({ ...capture.anchors[part]! }),
      }));
      const validity: CameraAnchorValidityInterval[] = [];
      let start: number | null = null;
      let previousValidTime: number | null = null;
      for (const capture of captures) {
        const value = capture.anchors[part];
        if (value === null || value === undefined) {
          if (start !== null && previousValidTime !== null) {
            validity.push(Object.freeze({ start, end: capture.time }));
            start = null;
            previousValidTime = null;
          }
          continue;
        }
        if (start === null) {
          start = capture.time;
        } else if (previousValidTime !== null && capture.time - previousValidTime > input.cadenceSeconds * 1.5) {
          validity.push(Object.freeze({ start, end: previousValidTime + input.cadenceSeconds }));
          start = capture.time;
        }
        previousValidTime = capture.time;
      }
      if (start !== null && previousValidTime !== null) {
        validity.push(Object.freeze({ start, end: previousValidTime + input.cadenceSeconds }));
      }

      const events: CameraAnchorEvent[] = [];
      for (const eventTime of input.eventTimes ?? []) {
        const right = valid.find((capture) => capture.time === eventTime)?.anchors[part];
        const leftCapture = [...valid].reverse().find((capture) => capture.time < eventTime);
        const left = leftCapture?.anchors[part];
        if (leftCapture && left && right && eventTime - leftCapture.time <= input.cadenceSeconds * 1.5
          && Number.isFinite(left.x) && Number.isFinite(left.y)) {
          events.push(Object.freeze({
            time: eventTime,
            left: Object.freeze({ ...left }),
            right: Object.freeze({ ...right }),
          }));
        }
      }

      prepared.push(Object.freeze({
        version: 1 as const,
        revision: input.revision,
        characterId,
        part,
        validity: Object.freeze(validity),
        samples: Object.freeze(samples),
        events: Object.freeze(events),
      }));
    }
  }
  return Object.freeze(prepared);
}
