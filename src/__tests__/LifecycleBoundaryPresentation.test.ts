import { describe, expect, it } from 'vitest';
import {
  getLifecycleBoundaryFootprintRange,
  getLifecycleBoundaryPresentationMetrics,
  LIFECYCLE_BOUNDARY_MIN_SHELL_PX,
  LIFECYCLE_BOUNDARY_PAD_PX,
} from '../ui/timeline/lifecycleBoundaryPresentation';

describe('lifecycleBoundaryPresentation', () => {
  it('uses transition duration for enter boundary visual metrics', () => {
    const metrics = getLifecycleBoundaryPresentationMetrics(
      {
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A', durationSeconds: 0.5 },
      },
      100,
    );
    expect(metrics.isLifecycleBoundary).toBe(true);
    expect(metrics.boundary).toBe('start');
    expect(metrics.transitionDurationSeconds).toBe(0.5);
    expect(metrics.transitionWidthPx).toBe(50);
    expect(metrics.visualWidthPx).toBe(50 + LIFECYCLE_BOUNDARY_PAD_PX);
    expect(metrics.canResizeTransition).toBe(true);
  });

  it('applies min shell + pad when transition is zero', () => {
    const metrics = getLifecycleBoundaryPresentationMetrics(
      {
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A', durationSeconds: 0 },
      },
      100,
    );
    expect(metrics.transitionDurationSeconds).toBe(0);
    expect(metrics.visualWidthPx).toBe(LIFECYCLE_BOUNDARY_MIN_SHELL_PX + LIFECYCLE_BOUNDARY_PAD_PX);
    expect(metrics.canResizeTransition).toBe(false);
  });

  it('uses semantic lifecycle defaults when transition fields are omitted', () => {
    const characterExit = getLifecycleBoundaryPresentationMetrics(
      {
        type: 'characterPresence',
        params: { mode: 'exit', id: 'A' },
      },
      100,
    );
    expect(characterExit.transitionDurationSeconds).toBe(0.6);
    expect(characterExit.transitionWidthPx).toBe(60);

    const environmentRemove = getLifecycleBoundaryPresentationMetrics(
      {
        type: 'environmentLayer',
        params: { mode: 'remove', layerId: 'background' },
      },
      100,
    );
    expect(environmentRemove.transitionDurationSeconds).toBe(0.6);
    expect(environmentRemove.transitionWidthPx).toBe(60);

    const bgmStop = getLifecycleBoundaryPresentationMetrics(
      {
        type: 'audio',
        params: { role: 'bgm', mode: 'stop' },
      },
      100,
    );
    expect(bgmStop.transitionDurationSeconds).toBe(0.5);
    expect(bgmStop.transitionWidthPx).toBe(50);
  });

  it('keeps footprint presentation-only (pad does not invent semantic duration)', () => {
    const metrics = getLifecycleBoundaryPresentationMetrics(
      {
        type: 'characterPresence',
        params: { mode: 'enter', id: 'A', durationSeconds: 1 },
      },
      50,
    );
    const range = getLifecycleBoundaryFootprintRange(2, metrics, 50);
    expect(metrics.semanticDurationSeconds).toBe(1);
    expect(range.end - range.start).toBeGreaterThan(1);
    expect(range.start).toBe(2);
  });

  it('does not mark ordinary dialogue as lifecycle boundary', () => {
    const metrics = getLifecycleBoundaryPresentationMetrics(
      {
        type: 'dialogue',
        params: { speaker: 'A', text: 'hi', durationSeconds: 2 },
      },
      40,
    );
    expect(metrics.isLifecycleBoundary).toBe(false);
  });

  it.each([0, 0.1, 0.3])('uses the ordinary minimum width for subtitle visibility at duration %s', (durationSeconds) => {
    for (const visible of [false, true]) {
      const metrics = getLifecycleBoundaryPresentationMetrics({
        type: 'dialogueVisibility', params: { visible, durationSeconds },
      }, 40);
      expect(metrics.visualWidthPx).toBe(Math.max(4, durationSeconds * 40));
      expect(metrics.semanticDurationSeconds).toBe(durationSeconds);
      expect(metrics.isLifecycleBoundary).toBe(false);
    }
  });
});
