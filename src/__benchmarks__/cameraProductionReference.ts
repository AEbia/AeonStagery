import type { CameraAnchorTrajectory } from '../engine/CameraChannelEvaluator';

/** Independent closed-form oracle for this benchmark's fixed zoom=2, s=.9.
 * Integrate the prepared piecewise-linear curve, splitting exactly at clamp
 * crossings. Event-bearing synthetic cases use the separate RK4 test oracle.
 */
export function referencePreparedFollow(trajectory: CameraAnchorTrajectory, queryTime: number) {
  if (trajectory.events.length) throw new Error('This reference requires the benchmark event-free track.');
  let x = 0.5;
  let y = 0.5;
  const rate = -60 * Math.log(0.9);
  const clamp = (value: number) => Math.max(0.25, Math.min(value, 0.75));
  for (const interval of trajectory.validity) {
    const samples = trajectory.samples.filter(sample => sample.time >= interval.start && sample.time <= interval.end);
    for (let index = 1; index < samples.length; index++) {
      const from = samples[index - 1]; const to = samples[index];
      if (from.time >= queryTime) break;
      const fraction = Math.min(1, (queryTime - from.time) / (to.time - from.time));
      if (fraction <= 0) continue;
      const splits = [0, fraction];
      for (const axis of ['x', 'y'] as const) {
        const difference = to.position[axis] - from.position[axis];
        if (difference === 0) continue;
        for (const boundary of [0.25, 0.75]) {
          const crossing = (boundary - from.position[axis]) / difference;
          if (crossing > 0 && crossing < fraction) splits.push(crossing);
        }
      }
      splits.sort((left, right) => left - right);
      for (let split = 1; split < splits.length; split++) {
        const a = splits[split - 1]; const b = splits[split];
        const elapsed = (to.time - from.time) * (b - a);
        if (elapsed === 0) continue;
        const decay = Math.exp(-rate * elapsed);
        const advance = (value: number, axis: 'x' | 'y') => {
          const difference = to.position[axis] - from.position[axis];
          const start = clamp(from.position[axis] + a * difference);
          const end = clamp(from.position[axis] + b * difference);
          // Integrate the exponential convolution of a linear forcing term.
          return value * decay + start * (1 - decay)
            + (end - start) / elapsed * (elapsed - (1 - decay) / rate);
        };
        x = advance(x, 'x'); y = advance(y, 'y');
      }
    }
  }
  return { x, y };
}
