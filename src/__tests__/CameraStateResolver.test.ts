import { describe, expect, it } from 'vitest';
import { computeCameraStateAtTime, prepareCameraZoomResolver } from '../engine/CameraStateResolver';
import type { RuntimeTimelineAction } from '../engine/RuntimeTimelineScene';

describe('computeCameraStateAtTime', () => {
  it.each(['stop', 'duration'] as const)('holds the release-time anchor after follow %s without a trajectory', operation => {
    const timeline: RuntimeTimelineAction[] = [
      { _id: 'zoom', action: 'cameraMotion', time: 0, params: { zoom: 2, duration: 0, _cameraProperties: ['zoom'] } },
      { _id: 'follow', action: 'cameraFollow', time: 1,
        params: { characterId: 'hero', smoothing: 0.85, ...(operation === 'duration' ? { duration: 1 } : {}) } },
      ...(operation === 'stop' ? [{ _id: 'stop', action: 'cameraUnfollow' as const, time: 2, params: {} }] : []),
    ];
    const anchorAt = (time: number) => ({ x: 0.4 + time * 0.1, y: 0.5 });
    // Cold direct seek, forward export samples, then out-of-order seeks.
    for (const time of [3, 2, 2.5, 3, 4, 2.25]) {
      const state = computeCameraStateAtTime(timeline, time, {
        resolveCharacterPosition: () => anchorAt(time),
        resolveCharacterPositionAtTime: (_id, atTime) => anchorAt(atTime),
      });
      expect(state.follow).toBeNull();
      expect(state.position.x).toBeCloseTo(0.6, 8);
      expect(state.position.y).toBe(0.5);
    }
  });

  it('prepares a zoom-only history that matches motion, path, relative zoom, and reset sampling', () => {
    const timeline: RuntimeTimelineAction[] = [
      { _id: 'zoom-start', action: 'cameraMotion', time: 0, params: { zoom: 2, duration: 0, _cameraProperties: ['zoom'] } },
      {
        _id: 'zoom-path',
        action: 'cameraPath', time: 1, params: {
          keyframes: [{ time: 0, zoom: 2 }, { time: 2, zoom: 4, ease: 'linear' }],
        },
      },
      { _id: 'zoom-relative', action: 'cameraMotion', time: 3, params: { zoom: '+=1', duration: 2, easing: 'linear', _cameraProperties: ['zoom'] } },
      { _id: 'zoom-reset', action: 'cameraReset', time: 6, params: { duration: 2, easing: 'linear' } },
    ];
    const preparedZoom = prepareCameraZoomResolver(timeline);

    for (const time of [0, 0.5, 1, 1.5, 2.5, 3, 4, 5, 6, 7, 8, 9]) {
      expect(preparedZoom(time)).toBeCloseTo(
        computeCameraStateAtTime(timeline, time, { compiledChannelOwnership: true }).zoom,
        8,
      );
    }
  });

  it('returns stage-default state with no coverage before the first camera writer', () => {
    const timeline = [
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero' } },
    ];

    const resolved = computeCameraStateAtTime(timeline as any, 2);

    expect(resolved.position).toEqual({ x: 0.5, y: 0.5 });
    expect(resolved.zoom).toBe(1);
    expect(resolved.rotation).toBe(0);
    expect(resolved.follow).toBeNull();
    expect(resolved.coverage).toEqual({ position: false, zoom: false, rotation: false });
  });

  it('interpolates a finite pan segment and latches its end value afterwards', () => {
    const timeline = [
      { action: 'cameraMotion', time: 2, params: { move: 'pan', duration: 1, easing: 'linear', target: [0.3, 0.6] } },
    ];

    // Before the writer starts: baseline, no position coverage yet.
    expect(computeCameraStateAtTime(timeline as any, 1).position).toEqual({ x: 0.5, y: 0.5 });
    expect(computeCameraStateAtTime(timeline as any, 1).coverage.position).toBe(false);

    // Mid-segment, linear ease at progress 0.5: worked example (0.4, 0.55).
    const mid = computeCameraStateAtTime(timeline as any, 2.5);
    expect(mid.position.x).toBeCloseTo(0.4, 6);
    expect(mid.position.y).toBeCloseTo(0.55, 6);
    expect(mid.coverage.position).toBe(true);

    // After the segment ends the written value latches.
    const after = computeCameraStateAtTime(timeline as any, 4);
    expect(after.position).toEqual({ x: 0.3, y: 0.6 });
  });

  it('preserves the legacy targetless pan default by recentering after an off-center writer', () => {
    const timeline = [
      { action: 'cameraMotion', time: 0, params: { move: 'pan', duration: 0, target: [0.8, 0.7] } },
      { action: 'cameraMotion', time: 1, params: { move: 'pan', duration: 0 } },
    ];

    const resolved = computeCameraStateAtTime(timeline as any, 2);

    expect(resolved.position).toEqual({ x: 0.5, y: 0.5 });
    expect(resolved.coverage.position).toBe(true);
  });

  it('preserves legacy default target and zoom behavior for push, pull, zoom, and tilt moves', () => {
    const cases = [
      { move: 'push', position: { x: 0.5, y: 0.4 }, zoom: 1.3 },
      { move: 'pull', position: { x: 0.5, y: 0.5 }, zoom: 0.7 },
      { move: 'zoom', position: { x: 0.5, y: 0.5 }, zoom: 1.5 },
      { move: 'tilt', position: { x: 0.8, y: 0.7 }, zoom: 1 },
    ];
    for (const expected of cases) {
      const resolved = computeCameraStateAtTime([
        { action: 'cameraMotion', time: 0, params: { move: 'pan', duration: 0, target: [0.8, 0.8] } },
        { action: 'cameraMotion', time: 1, params: { move: expected.move, duration: 0 } },
      ] as any, 2);

      expect(resolved.position).toEqual(expected.position);
      expect(resolved.zoom).toBeCloseTo(expected.zoom, 6);
    }
  });

  it('does not apply legacy position defaults when a requested character anchor is unavailable', () => {
    for (const move of ['pan', 'push', 'zoom']) {
      const timeline = [
        { action: 'cameraMotion', time: 0, params: { move: 'pan', duration: 0, target: [0.8, 0.7] } },
        { action: 'cameraMotion', time: 1, params: { move, duration: 0, characterId: 'missing' } },
      ];

      const resolved = computeCameraStateAtTime(timeline as any, 2, { resolveCharacterPosition: () => null });

      expect(resolved.position).toEqual({ x: 0.8, y: 0.7 });
      if (move === 'push') expect(resolved.zoom).toBeCloseTo(1.3, 6);
      if (move === 'zoom') expect(resolved.zoom).toBeCloseTo(1.5, 6);
    }
  });

  it('does not use an explicit point when a requested focus character cannot be resolved', () => {
    const timeline = [
      { action: 'cameraMotion', time: 0, params: { move: 'pan', duration: 0, target: [0.8, 0.7] } },
      { action: 'cameraMotion', time: 1, params: {
        move: 'pan', duration: 0, focus: { character: 'missing', point: [0.2, 0.3] },
      } },
    ];

    const resolved = computeCameraStateAtTime(timeline as any, 2, { resolveCharacterPosition: () => null });

    expect(resolved.position).toEqual({ x: 0.8, y: 0.7 });
  });

  it('resolves a valid legacy characterId anchor at the action start', () => {
    const timeline = [
      { action: 'cameraMotion', time: 1, params: { move: 'pan', duration: 0, characterId: 'hero', targetPart: 'chest' } },
    ];
    const resolved = computeCameraStateAtTime(timeline as any, 2, {
      resolveCharacterPositionAtTime: (_id, _time, part) => part === 'chest' ? { x: 0.7, y: 0.4 } : null,
      resolveCharacterPosition: () => ({ x: 0.1, y: 0.2 }),
    });

    expect(resolved.position).toEqual({ x: 0.7, y: 0.4 });
  });

  it('lets follow own the position channel until it is released', () => {
    const deps = { resolveCharacterPosition: () => ({ x: 0.7, y: 0.6 }) };
    const timeline = [
      // Push in first: zoom 2 opens the viewport clamp (halfView = 0.25) so
      // the follow framing has room off-center.
      { action: 'cameraMotion', time: 4, params: { move: 'push', duration: 1, easing: 'linear', target: [0.5, 0.4], zoom: 2 } },
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero', offset: [0.1, -0.1] } },
      { action: 'cameraUnfollow', time: 7, params: {} },
    ];

    // While active the resolved position tracks the deterministic anchor +
    // offset, clamped into the zoom-2 viewport: (0.8 → 0.75, 0.5). One second
    // past the entry transient only a ~1e-5 residue of the glide remains.
    const active = computeCameraStateAtTime(timeline as any, 6, deps);
    expect(active.follow).toEqual({ characterId: 'hero', offset: { x: 0.1, y: -0.1 } });
    expect(active.position.x).toBeCloseTo(0.75, 4);
    expect(active.position.y).toBeCloseTo(0.5, 4);
    expect(active.zoom).toBe(2);

    // After release the composed framing latches and follow is gone.
    const released = computeCameraStateAtTime(timeline as any, 8, deps);
    expect(released.follow).toBeNull();
    expect(released.position.x).toBeCloseTo(0.75, 4);
    expect(released.position.y).toBeCloseTo(0.5, 4);
    expect(released.zoom).toBe(2);
  });

  it('ends an indefinite follow only through release actions, honoring authored durations', () => {
    const deps = { resolveCharacterPosition: () => ({ x: 0.7, y: 0.6 }) };
    const timeline = [
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero' } },
      { action: 'cameraUnfollow', time: 7, params: {} },
      { action: 'cameraFollow', time: 10, params: { characterId: 'hero', duration: 2 } },
    ];

    expect(computeCameraStateAtTime(timeline as any, 6.5, deps).follow).not.toBeNull();
    expect(computeCameraStateAtTime(timeline as any, 11, deps).follow).not.toBeNull();
    // Authored duration expires the second follow without a stop statement.
    expect(computeCameraStateAtTime(timeline as any, 13, deps).follow).toBeNull();
  });

  it('keeps prior channel values when a follow anchor cannot be resolved', () => {
    const timeline = [
      { action: 'cameraMotion', time: 1, params: { move: 'pan', duration: 1, easing: 'linear', target: [0.3, 0.6] } },
      { action: 'cameraFollow', time: 2, params: { characterId: 'ghost' } },
    ];

    const resolved = computeCameraStateAtTime(timeline as any, 3, {
      resolveCharacterPosition: () => null,
    });
    expect(resolved.follow).not.toBeNull();
    expect(resolved.position).toEqual({ x: 0.3, y: 0.6 });
  });

  it('resets every channel to the stage baseline and terminates follow', () => {
    const deps = { resolveCharacterPosition: () => ({ x: 0.7, y: 0.6 }) };
    const timeline = [
      { action: 'cameraMotion', time: 4, params: { move: 'push', duration: 1, easing: 'linear', target: [0.5, 0.4], zoom: 2 } },
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero' } },
      { action: 'cameraReset', time: 7, params: { duration: 1, easing: 'linear' } },
    ];

    // Just before the reset the followed framing is live.
    const before = computeCameraStateAtTime(timeline as any, 6.5, deps);
    expect(before.follow).not.toBeNull();
    expect(before.zoom).toBe(2);

    // At the start of the reset (7.0s): follow is released, channels remain at pre-reset state
    const atStart = computeCameraStateAtTime(timeline as any, 7, deps);
    expect(atStart.follow).toBeNull();
    expect(atStart.position.x).toBeCloseTo(0.7, 4);
    expect(atStart.position.y).toBeCloseTo(0.6, 4);
    expect(atStart.zoom).toBe(2);

    // Midway through reset (7.5s, linear ease): halfway between (0.7, 0.6, 2) and baseline (0.5, 0.5, 1)
    const mid = computeCameraStateAtTime(timeline as any, 7.5, deps);
    expect(mid.follow).toBeNull();
    expect(mid.position.x).toBeCloseTo(0.6, 4);
    expect(mid.position.y).toBeCloseTo(0.55, 4);
    expect(mid.zoom).toBeCloseTo(1.5, 4);

    // After the reset finishes every channel is back at the baseline.
    const after = computeCameraStateAtTime(timeline as any, 9, deps);
    expect(after.follow).toBeNull();
    expect(after.position).toEqual({ x: 0.5, y: 0.5 });
    expect(after.zoom).toBe(1);
    expect(after.rotation).toBe(0);
    expect(after.coverage).toEqual({ position: true, zoom: true, rotation: true });
  });

  it('resolves focus-lowered pan segments against the deterministic character anchor', () => {
    const timeline = [
      {
        action: 'cameraMotion',
        time: 2,
        params: { move: 'pan', duration: 1, easing: 'linear', focus: { character: 'tomori', part: 'head' } },
      },
    ];
    const deps = {
      resolveCharacterPosition: (_id: string, part?: string) =>
        part === 'head' ? { x: 0.7, y: 0.35 } : { x: 0.5, y: 0.6 },
    };

    const done = computeCameraStateAtTime(timeline as any, 4, deps);
    expect(done.position).toEqual({ x: 0.7, y: 0.35 });
    expect(done.zoom).toBe(1);
    expect(done.coverage.position).toBe(true);
    expect(done.coverage.zoom).toBe(false);
  });

  it('captures a focus anchor from the action start when evaluating a subframe', () => {
    const timeline = [
      {
        action: 'cameraMotion',
        time: 2,
        params: { move: 'pan', duration: 1, easing: 'linear', focus: { character: 'tomori', part: 'head' } },
      },
    ];
    const deps = {
      resolveCharacterPositionAtTime: (_id: string, at: number) =>
        at < 2.5 ? { x: 0.3, y: 0.4 } : { x: 0.9, y: 0.8 },
      resolveCharacterPosition: () => ({ x: 0.9, y: 0.8 }),
    };

    const halfway = computeCameraStateAtTime(timeline as any, 2.5, deps);

    // The focus destination is latched at t=2 (0.3, 0.4), so its halfway
    // interpolation from the stage default is (0.4, 0.45).
    expect(halfway.position.x).toBeCloseTo(0.4, 6);
    expect(halfway.position.y).toBeCloseTo(0.45, 6);
  });

  it('takes over an active channel from the value at the later writer start', () => {
    const timeline = [
      { action: 'cameraMotion', time: 0, params: { move: 'pan', duration: 4, easing: 'linear', target: [0.2, 0.2] } },
      { action: 'cameraMotion', time: 2, params: { move: 'pan', duration: 2, easing: 'linear', target: [0.8, 0.8] } },
    ];

    const midway = computeCameraStateAtTime(timeline as any, 3);

    // The first pan has reached (0.35, 0.35) at the takeover time. The new
    // pan then interpolates halfway to (0.8, 0.8).
    expect(midway.position.x).toBeCloseTo(0.575, 6);
    expect(midway.position.y).toBeCloseTo(0.575, 6);
  });

  it('does not freeze an active position writer at an unrelated scene event', () => {
    const timeline = [
      { action: 'cameraMotion', time: 0, params: { move: 'pan', duration: 4, easing: 'linear', target: [0.2, 0.2] } },
      { action: 'backgroundSet', time: 2, params: { color: '#000000' } },
    ];

    const midway = computeCameraStateAtTime(timeline as any, 3);

    expect(midway.position.x).toBeCloseTo(0.275, 6);
    expect(midway.position.y).toBeCloseTo(0.275, 6);
  });

  it('keeps position moving through unrelated zoom and rotation writers', () => {
    const timeline = [
      { action: 'cameraMotion', time: 0, params: { move: 'pan', duration: 4, easing: 'linear', target: [0.2, 0.2] } },
      { action: 'cameraMotion', time: 2, params: { move: 'zoom', duration: 2, easing: 'linear', focus: {}, zoom: 2, _cameraProperties: ['zoom'] } },
      { action: 'cameraMotion', time: 2.5, params: { move: 'rotate', duration: 2, easing: 'linear', angle: 20, _cameraProperties: ['rotation'] } },
    ];

    const midway = computeCameraStateAtTime(timeline as any, 3);

    expect(midway.position.x).toBeCloseTo(0.275, 6);
    expect(midway.position.y).toBeCloseTo(0.275, 6);
    expect(midway.zoom).toBeCloseTo(1.5, 6);
    expect(midway.rotation).toBeCloseTo(5, 6);
  });

  it('preserves the x axis when a later sparse tilt writer takes over only y', () => {
    const timeline = [
      { action: 'cameraMotion', time: 0, params: { move: 'pan', duration: 4, easing: 'linear', target: [0.2, 0.2] } },
      { action: 'cameraMotion', time: 2, params: { move: 'tilt', duration: 2, easing: 'linear', toY: 0.7 } },
    ];

    const midway = computeCameraStateAtTime(timeline as any, 3);

    expect(midway.position.x).toBeCloseTo(0.275, 6);
    expect(midway.position.y).toBeCloseTo(0.525, 6);
  });

  it('preserves character focus anchors without a viewport clamp at low zoom', () => {
    const timeline = [
      {
        action: 'cameraMotion',
        time: 2,
        params: { move: 'pan', duration: 1, easing: 'linear', focus: { character: 'tomori', part: 'head' }, zoom: 1.2 },
      },
    ];
    const deps = {
      resolveCharacterPosition: (_id: string, part?: string) =>
        part === 'head' ? { x: 0.7, y: 0.35 } : { x: 0.5, y: 0.6 },
    };

    const done = computeCameraStateAtTime(timeline as any, 4, deps);
    expect(done.position.x).toBeCloseTo(0.7, 5);
    expect(done.position.y).toBeCloseTo(0.35, 5);
  });

  it('resolves zoom-only, rotation-only and tilt motions on their own channels', () => {
    const timeline = [
      { action: 'cameraMotion', time: 2, params: { move: 'zoom', duration: 1, easing: 'linear', zoom: '+=0.5', _cameraProperties: ['zoom'] } },
      { action: 'cameraMotion', time: 4, params: { move: 'rotate', duration: 1, easing: 'linear', angle: 12, _cameraProperties: ['rotation'] } },
      { action: 'cameraMotion', time: 6, params: { move: 'tilt', duration: 1, easing: 'linear', toY: 0.7 } },
    ];

    // Relative zoom resolves against the channel value at segment start.
    const zoomed = computeCameraStateAtTime(timeline as any, 3.5);
    expect(zoomed.zoom).toBeCloseTo(1.5, 6);
    expect(zoomed.coverage.zoom).toBe(true);
    expect(zoomed.coverage.position).toBe(false); // Move labels do not create an unwritten position track.

    const rotated = computeCameraStateAtTime(timeline as any, 5.5);
    expect(rotated.rotation).toBeCloseTo(12, 6);
    expect(rotated.coverage.rotation).toBe(true);
    expect(rotated.zoom).toBeCloseTo(1.5, 6); // untouched by the rotate segment

    const tilted = computeCameraStateAtTime(timeline as any, 7.5);
    expect(tilted.position.y).toBeCloseTo(0.7, 6);
    expect(tilted.position.x).toBeCloseTo(0.5, 6); // tilt never touches x
  });

  it('interpolates path keyframes per segment with per-keyframe eases', () => {
    const timeline = [
      {
        action: 'cameraPath',
        time: 1,
        params: {
          keyframes: [
            { time: 0, position: [0.2, 0.5], zoom: 1 },
            { time: 1, position: [0.5, 0.3], zoom: 1.5, ease: 'linear' },
            { time: 2, rotation: 5, ease: 'linear' },
          ],
        },
      },
    ];

    // Mid first→second keyframe at local t=0.5 (linear): worked example.
    const mid = computeCameraStateAtTime(timeline as any, 1.5);
    expect(mid.position.x).toBeCloseTo(0.35, 6);
    expect(mid.position.y).toBeCloseTo(0.4, 6);
    expect(mid.zoom).toBeCloseTo(1.25, 6);

    // Second→third segment only animates the newly defined channel.
    const seg2 = computeCameraStateAtTime(timeline as any, 2.2);
    expect(seg2.position).toEqual({ x: 0.5, y: 0.3 });
    expect(seg2.zoom).toBeCloseTo(1.5, 6);
    expect(seg2.rotation).toBeCloseTo(3, 6); // Rotation's first key interpolates from action start at local t=0.

    // After the final keyframe everything latches.
    const done = computeCameraStateAtTime(timeline as any, 4);
    expect(done.position).toEqual({ x: 0.5, y: 0.3 });
    expect(done.zoom).toBeCloseTo(1.5, 6);
    expect(done.rotation).toBeCloseTo(5, 6);
    expect(done.coverage).toEqual({ position: true, zoom: true, rotation: true });
  });

  it('interpolates from action start to a nonzero first path key and evaluates yoyo repeats', () => {
    const initialPath = [{
      action: 'cameraPath',
      time: 1,
      params: { keyframes: [{ time: 1, position: [0.9, 0.5], zoom: 2, ease: 'linear' }], ease: 'linear' },
    }];
    const firstKeyMidpoint = computeCameraStateAtTime(initialPath as any, 1.5);
    expect(firstKeyMidpoint.position.x).toBeCloseTo(0.7, 6);
    expect(firstKeyMidpoint.zoom).toBeCloseTo(1.5, 6);

    const repeatedPath = [{
      action: 'cameraPath',
      time: 1,
      params: {
        keyframes: [
          { time: 0, position: [0.2, 0.5] },
          { time: 2, position: [0.8, 0.5], ease: 'linear' },
        ],
        repeat: 1,
        yoyo: true,
        ease: 'linear',
      },
    }];
    const yoyoMidpoint = computeCameraStateAtTime(repeatedPath as any, 3.5);
    expect(yoyoMidpoint.position.x).toBeCloseTo(0.65, 6);
  });

  it('keeps each path property interpolating across keys that author other properties', () => {
    const timeline = [{
      action: 'cameraPath',
      time: 0,
      params: {
        keyframes: [
          { time: 0, position: [0.2, 0.5] },
          { time: 1, zoom: 2 },
          { time: 2, position: [0.8, 0.5], ease: 'linear' },
        ],
      },
    }];

    const midpoint = computeCameraStateAtTime(timeline as any, 1);

    expect(midpoint.position.x).toBeCloseTo(0.5, 6);
    expect(midpoint.zoom).toBe(2);
  });

  it('applies same-time camera writers in statement order', () => {
    const pan = (target: [number, number]) => ({
      action: 'cameraMotion',
      time: 2,
      params: { move: 'pan', duration: 1, easing: 'linear', target },
    });

    const panWins = computeCameraStateAtTime([pan([0.8, 0.8]), { action: 'cameraReset', time: 2 }] as any, 3);
    expect(panWins.position).toEqual({ x: 0.5, y: 0.5 }); // reset listed second wins

    const resetWins = computeCameraStateAtTime([{ action: 'cameraReset', time: 2 }, pan([0.8, 0.8])] as any, 3);
    expect(resetWins.position).toEqual({ x: 0.8, y: 0.8 }); // pan listed second wins
  });
});

/**
 * Reported regression: seeking into the middle of a camera follow presented
 * the follow's TERMINAL framing (the tracked anchor) instead of the
 * intermediate transition state. Playback enters a follow through tickFollow()'s
 * exponential smoothing — alpha = 1 − smoothing^(60·dt) per frame — so the
 * camera glides from its pre-follow position toward the anchor. The resolver
 * must mirror that transient deterministically: with λ = −60·ln(smoothing),
 *
 *   position(t) = target + (preFollow − startTarget) · e^(−λ·(t−followStart))
 *
 * where both targets are viewport-clamped like tickFollow() does.
 */
describe('camera follow entry transient (seek presents the intermediate state)', () => {
  // Shared pre-follow framing: push@4 lands at (0.5, 0.4) @ zoom 2 (linear).
  const pushFirst = { action: 'cameraMotion', time: 4, params: { move: 'push', duration: 1, easing: 'linear', target: [0.5, 0.4], zoom: 2 } };
  const deps = { resolveCharacterPosition: () => ({ x: 0.7, y: 0.6 }) };
  // Default smoothing 0.85 → λ ≈ 9.7511; weight at Δ=0.2s ≈ 0.1422417.
  const W = 0.1422417;

  it('decays exponentially from the pre-follow framing toward the tracked anchor', () => {
    const timeline = [
      pushFirst,
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero', offset: [0.1, -0.1] } },
    ];

    const resolved = computeCameraStateAtTime(timeline as any, 5.2, deps);
    expect(resolved.follow).not.toBeNull();
    // Target (0.8→0.75 clamp, 0.5); composed = target + (P₀ − target)·W.
    expect(resolved.position.x).toBeCloseTo(0.75 - 0.25 * W, 5);
    expect(resolved.position.y).toBeCloseTo(0.5 - 0.1 * W, 5);
  });

  it('lands exactly on the pre-follow framing when queried at the follow instant', () => {
    const timeline = [
      pushFirst,
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero', offset: [0.1, -0.1] } },
    ];

    const resolved = computeCameraStateAtTime(timeline as any, 5, deps);
    expect(resolved.follow).not.toBeNull();
    expect(resolved.position).toEqual({ x: 0.5, y: 0.4 });
  });

  it('converges to the steady-state anchor well after the entry window', () => {
    const timeline = [
      pushFirst,
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero', offset: [0.1, -0.1] } },
    ];

    const resolved = computeCameraStateAtTime(timeline as any, 6, deps);
    expect(resolved.position.x).toBeCloseTo(0.75, 4);
    expect(resolved.position.y).toBeCloseTo(0.5, 4);
  });

  it('measures the transient against the anchor captured at the follow start for moving characters', () => {
    const timeline = [
      pushFirst,
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero' } },
    ];
    const movingDeps = {
      resolveCharacterPosition: () => ({ x: 0.75, y: 0.6 }),
      resolveCharacterPositionAtTime: (_id: string, at: number) => (at < 6 ? { x: 0.55, y: 0.6 } : { x: 0.75, y: 0.6 }),
    };

    const resolved = computeCameraStateAtTime(timeline as any, 5.2, movingDeps);
    // startTarget.x = 0.55 (anchor at t=5), current target.x = 0.75.
    expect(resolved.position.x).toBeCloseTo(0.75 + (0.5 - 0.55) * W, 5);
    expect(resolved.position.y).toBeCloseTo(0.6 + (0.4 - 0.6) * W, 5);
  });

  it('honors an authored slow smoothing so the intermediate window stays observable', () => {
    const timeline = [
      pushFirst,
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero', offset: [0.1, -0.1], smoothing: 0.999 } },
    ];
    // λ = −60·ln(0.999) ≈ 0.06; weight(0.2) ≈ 0.988066.
    const wSlow = 0.988066;

    const resolved = computeCameraStateAtTime(timeline as any, 5.2, deps);
    expect(resolved.position.x).toBeCloseTo(0.75 - 0.25 * wSlow, 5);
    expect(resolved.position.y).toBeCloseTo(0.5 - 0.1 * wSlow, 5);
  });

  it('caps the transient at the release instant so short follows latch their mid-glide frame', () => {
    const timeline = [
      pushFirst,
      { action: 'cameraFollow', time: 5, params: { characterId: 'hero', offset: [0.1, -0.1], duration: 0.3 } },
    ];
    // Elapsed capped at 0.3s → weight ≈ 0.0536464; latch holds that frame.
    const wCap = 0.0536464;

    const released = computeCameraStateAtTime(timeline as any, 9, deps);
    expect(released.follow).toBeNull();
    expect(released.position.x).toBeCloseTo(0.75 - 0.25 * wCap, 5);
    expect(released.position.y).toBeCloseTo(0.5 - 0.1 * wCap, 5);
  });
});
