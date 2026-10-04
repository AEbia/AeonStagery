/**
 * Probe 2: seek expression reconstruction must match playback semantics by
 * keeping the PREVIOUS expression in the SDK queue as a resident (fully-faded)
 * writer while the target expression fades in at the seeked elapsed. Without
 * the previous entry (playback's _setExpression never stops the old one), a
 * seek would snap the old expression's exclusive parameters back to neutral
 * while only the target's parameters fade — the visible "突变" (snap).
 */
import { describe, expect, it, vi } from 'vitest';
import { Cubism2PixiLive2DModelControls } from '../engine/Live2DRuntimeAdapter';
import { applyRenderHook } from '../engine/Live2DModelSetup';

interface QueueEntry {
  motion: {
    name?: string;
    updateParamExe: (model: any, time: number, weight: number) => void;
  };
  startTime: number | null;
}

function createHarness() {
  let utTime = 100_000;

  const parameterValues = new Float32Array([0.25]);
  const coreModel = {
    getParamFloat: () => parameterValues[0],
    setParamFloat: (_id: string | number, value: number) => { parameterValues[0] = value; },
    getParameterValues: () => parameterValues,
    saveParam: vi.fn(),
    loadParam: vi.fn(),
    update: vi.fn(),
  };

  const queue: QueueEntry[] = [];
  const startTimes: Array<{ name: string; startTime: number }> = [];
  const queueManager = {
    startMotion: (motion: QueueEntry['motion']) => { queue.push({ motion, startTime: null }); },
    stopAllMotions: () => { queue.length = 0; },
  };
  // Core SDK semantics: the queue entry latches its start time on its FIRST
  // updateParam from the current UtSystem clock, then the fade weight grows
  // from that latch.
  const updateParam = (model: any) => {
    for (const entry of queue) {
      if (entry.startTime === null) {
        entry.startTime = utTime;
        startTimes.push({ name: entry.motion.name ?? '?', startTime: utTime });
      }
      const elapsed = Math.max(0, utTime - entry.startTime);
      const weight = Math.max(0, Math.min(1, elapsed / 500));
      entry.motion.updateParamExe(model, elapsed, weight);
    }
  };
  const entriesSeen: Array<{ name: string; weight: number }> = [];
  const expressionA = {
    name: 'a',
    updateParamExe: (model: any, _time: number, weight: number) => {
      // A owns a parameter B does not touch (e.g. mouth).
      model.setParamFloat('PARAM_MOUTH_FORM', 0.9 * weight);
    },
  };
  const expressionB = {
    name: 'b',
    updateParamExe: (model: any, _time: number, weight: number) => {
      // B owns an exclusive parameter (e.g. eye) that should fade in.
      model.setParamFloat('PARAM_EYE_OPEN', 0.6 * weight);
    },
  };
  const defaultExpression = { name: 'default' };
  const expressionManager: any = {
    expressions: [expressionA, expressionB],
    definitions: [{ name: 'a' }, { name: 'b' }],
    currentExpression: defaultExpression,
    defaultExpression,
    reserveExpressionIndex: -1,
    queueManager,
    getExpressionIndex: (name: string) => name === 'a' ? 0 : name === 'b' ? 1 : -1,
    loadExpression: vi.fn(async (index: number) => (index === 0 ? expressionA : expressionB)),
    _setExpression: vi.fn((motion: any) => { queueManager.startMotion(motion); }),
    update: (model: any) => {
      const before = new Set(queue.map((entry) => entry.motion.name));
      updateParam(model);
      for (const entry of queue) {
        if (!before.has(entry.motion.name)) continue;
        const elapsed = Math.max(0, utTime - (entry.startTime ?? utTime));
        entriesSeen.push({ name: entry.motion.name ?? '?', weight: Math.max(0, Math.min(1, elapsed / 500)) });
      }
    },
  };
  const internalModel = {
    parameterValues,
    coreModel,
    motionManager: { expressionManager },
  };
  const model = {
    update: vi.fn((delta: number) => {
      if (delta <= 0) return;
      expressionManager.update(coreModel);
    }),
    render: vi.fn(),
    internalModel,
  };

  (globalThis as any).window = {
    UtSystem: {
      getUserTimeMSec: () => utTime,
      setUserTimeMSec: (value: number) => { utTime = value; },
    },
  };
  applyRenderHook('hero', model, vi.fn());

  return {
    controls: new Cubism2PixiLive2DModelControls(),
    model,
    expressionManager,
    startTimes,
    entriesSeen,
    coreModel,
    advanceClock: (ms: number) => { utTime += ms; },
  };
}

describe('seek expression previous-expression retention probe', () => {
  it('keeps the previous expression resident and latches the target at the seeked elapsed', async () => {
    const harness = createHarness();

    // Playback applied expression A (fully faded in) before the seek: enqueue,
// first update latches its start time, then the fade completes.
    harness.expressionManager.currentExpression = harness.expressionManager.expressions[0];
    harness.expressionManager._setExpression(harness.expressionManager.expressions[0]);
    harness.expressionManager.update(harness.coreModel); // latches startTime
    harness.advanceClock(600);
    harness.expressionManager.update(harness.coreModel);
    expect(harness.entriesSeen.at(-1)).toMatchObject({ name: 'a', weight: 1 });

    // Seek 200ms into expression B's 500ms fade-in, straight after A was
    // current. The target seek must land on the in-window weight, with A
    // still resident at weight 1 (playback parity).
    harness.entriesSeen.length = 0;
    harness.startTimes.length = 0;
    harness.expressionManager._setExpression.mockClear();
    await harness.controls.setExpressionForSeek(harness.model, 'b', 0.2);

    // _setExpression was called twice: previous first, then the target.
    expect(harness.expressionManager._setExpression).toHaveBeenCalledTimes(2);
    expect(harness.expressionManager._setExpression.mock.calls[0][0]).toBe(harness.expressionManager.expressions[0]);
    expect(harness.expressionManager._setExpression.mock.calls[1][0]).toBe(harness.expressionManager.expressions[1]);

    // The previous entry's start time lies far enough in the past to be fully
    // faded in, the target's lands at the seeked elapsed. The clock has
    // advanced to 100600 by now (100000 + 600ms playback before seek).
    expect(harness.startTimes[0].name).toBe('a');
    expect(harness.startTimes[0].startTime).toBeCloseTo(100_600 - 200 - 6000, 0);
    expect(harness.startTimes[1].name).toBe('b');
    expect(harness.startTimes[1].startTime).toBeCloseTo(100_600 - 200, 0);

    // First evaluation pass: previous at weight 1, target at fade(200/500).
    // (Entry start times latch on their first update, so the target's first
    // evaluation may run at the rewound clock, then the restored clock pass
    // lands on the seeked weight.)
    const targetWrites = harness.entriesSeen.filter((entry) => entry.name === 'b');
    expect(targetWrites.some((entry) => entry.weight > 0.3 && entry.weight <= 0.6)).toBe(true);
  });

  it('does not duplicate the previous entry when seeking the already-current expression', async () => {
    const harness = createHarness();
    harness.expressionManager.currentExpression = harness.expressionManager.expressions[1];

    harness.entriesSeen.length = 0;
    harness.startTimes.length = 0;
    await harness.controls.setExpressionForSeek(harness.model, 'b', 0.2);

    expect(harness.expressionManager._setExpression).toHaveBeenCalledTimes(1);
    expect(harness.expressionManager._setExpression.mock.calls[0][0]).toBe(harness.expressionManager.expressions[1]);
  });
});