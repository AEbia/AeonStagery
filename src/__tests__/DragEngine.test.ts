import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DragEngine } from '../engine/interaction/DragEngine';

describe('DragEngine', () => {
  let engine: DragEngine;

  beforeEach(() => {
    engine = new DragEngine();
  });

  it('isDragging is false initially', () => {
    expect(engine.isDragging).toBe(false);
  });

  it('beginDrag sets isDragging and fires onChange', () => {
    const fn = vi.fn();
    engine.onChange.add(fn);
    engine.beginDrag({ time: 3.0 }, { gridStep: 0.1, thresholdPx: 8 });
    expect(engine.isDragging).toBe(true);
    expect(fn).toHaveBeenCalled();
  });

  it('update returns delta unchanged when no snap config', () => {
    engine.beginDrag({ time: 3.0 }, { gridStep: 0, thresholdPx: 8 });
    const result = engine.update({ time: 1.5 });
    expect(result.time).toBeCloseTo(1.5);
  });

  it('update snaps to grid when gridStep is set', () => {
    engine.beginDrag({ time: 3.0 }, { gridStep: 0.1, thresholdPx: 8 });
    // rawDelta 0.27 → snapped to 0.3
    const result = engine.update({ time: 0.27 });
    expect(result.time).toBeCloseTo(0.3);
  });

  it('update snaps to magnetic target when within threshold', () => {
    engine.beginDrag(
      { time: 3.0 },
      {
        gridStep: 0.1,
        thresholdPx: 8,
        getSnapTargets: () => [5.0],
      },
    );
    // rawDelta 1.95 → targetTime = 3.0 + 1.95 = 4.95 → snaps to 5.0
    const result = engine.update({ time: 1.95 });
    expect(result.time).toBeCloseTo(2.0); // 5.0 - 3.0 = 2.0 delta
  });

  it('update does not snap to magnetic target beyond threshold', () => {
    engine.beginDrag(
      { time: 3.0 },
      {
        gridStep: 0.1,
        thresholdPx: 8,
        getSnapTargets: () => [10.0],
      },
    );
    // targetTime = 3.0 + 1.2 = 4.2, target = 10.0, gap = 5.8
    // 5.8 * 50 = 290px >> 8px threshold → no snap
    const result = engine.update({ time: 1.2 });
    expect(result.time).toBeCloseTo(1.2);
  });

  it('update supports multiple keys', () => {
    engine.beginDrag(
      { x: 0.5, y: 0.5 },
      { gridStep: 0.1, thresholdPx: 8 },
    );
    const result = engine.update({ x: 0.23, y: 0.37 });
    expect(result.x).toBeCloseTo(0.2);
    expect(result.y).toBeCloseTo(0.4);
  });

  it('commit returns final snapped values and ends drag', () => {
    const fn = vi.fn();
    engine.onChange.add(fn);
    engine.beginDrag({ time: 3.0 }, { gridStep: 0.1, thresholdPx: 8 });
    engine.update({ time: 0.27 });
    const final = engine.commit();

    expect(final.time).toBeCloseTo(0.3); // final returns snapped deltas
    expect(engine.isDragging).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2); // begin + commit
  });

  it('commit throws if not dragging', () => {
    expect(() => engine.commit()).toThrow('No active drag');
  });

  it('cancel ends drag without returning values', () => {
    const fn = vi.fn();
    engine.onChange.add(fn);
    engine.beginDrag({ time: 3.0 }, { gridStep: 0.1, thresholdPx: 8 });
    engine.update({ time: 0.5 });
    engine.cancel();

    expect(engine.isDragging).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('beginDrag throws if already dragging', () => {
    engine.beginDrag({ time: 1 }, { gridStep: 0.1, thresholdPx: 8 });
    expect(() =>
      engine.beginDrag({ time: 2 }, { gridStep: 0.1, thresholdPx: 8 }),
    ).toThrow('Drag already in progress');
  });

  it('snap to nearest of multiple targets', () => {
    engine.beginDrag(
      { time: 3.0 },
      {
        gridStep: 0.1,
        thresholdPx: 8,
        getSnapTargets: () => [4.8, 5.2],
      },
    );
    // rawDelta 2.15 → targetTime = 5.15 → nearest targets: 5.2 (dist 0.05) vs 4.8 (dist 0.35)
    const result = engine.update({ time: 2.15 });
    expect(result.time).toBeCloseTo(2.2); // 5.2 - 3.0
  });
});
