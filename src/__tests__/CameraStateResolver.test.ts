import { describe, expect, it } from 'vitest';
import { computeCameraStateAtTime } from '../engine/CameraStateResolver';

describe('computeCameraStateAtTime', () => {
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
      // Open the viewport first (zoom 2 → halfView 0.25) so the head anchor
      // has room off-center, mirroring moveTo()'s capture-time clamp.
      { action: 'cameraMotion', time: 1, params: { move: 'zoom', duration: 1, easing: 'linear', target: [0.5, 0.5], zoom: 2 } },
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
    expect(done.zoom).toBe(2);
    expect(done.coverage.position).toBe(true);
    expect(done.coverage.zoom).toBe(true);
  });

  it('clamps character-anchored moves into the segment zoom viewport like moveTo()', () => {
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

    // halfView at zoom 1.2 is ≈0.41667: x clamps to 0.58333, y stays.
    const done = computeCameraStateAtTime(timeline as any, 4, deps);
    expect(done.position.x).toBeCloseTo(0.583333, 5);
    expect(done.position.y).toBeCloseTo(0.416667, 5);
  });

  it('resolves zoom-only, rotation-only and tilt motions on their own channels', () => {
    const timeline = [
      { action: 'cameraMotion', time: 2, params: { move: 'zoom', duration: 1, easing: 'linear', zoom: '+=0.5' } },
      { action: 'cameraMotion', time: 4, params: { move: 'rotate', duration: 1, easing: 'linear', angle: 12 } },
      { action: 'cameraMotion', time: 6, params: { move: 'tilt', duration: 1, easing: 'linear', toY: 0.7 } },
    ];

    // Relative zoom resolves against the channel value at segment start.
    const zoomed = computeCameraStateAtTime(timeline as any, 3.5);
    expect(zoomed.zoom).toBeCloseTo(1.5, 6);
    expect(zoomed.coverage.zoom).toBe(true);
    expect(zoomed.coverage.position).toBe(true); // zoom move still tweens position toward its target point

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
    expect(seg2.rotation).toBeCloseTo(1, 6); // 20% through the linear rotation ramp

    // After the final keyframe everything latches.
    const done = computeCameraStateAtTime(timeline as any, 4);
    expect(done.position).toEqual({ x: 0.5, y: 0.3 });
    expect(done.zoom).toBeCloseTo(1.5, 6);
    expect(done.rotation).toBeCloseTo(5, 6);
    expect(done.coverage).toEqual({ position: true, zoom: true, rotation: true });
  });

  it('resolves the hitchcock dolly-zoom coupling from deterministic anchors', () => {
    const timeline = [
      {
        action: 'cameraHitchcock',
        time: 2,
        params: {
          characterId: 'hero',
          targetPart: 'head',
          screenTarget: [0.5, 0.3],
          zoomStart: 1,
          zoomEnd: 2,
          scaleStart: 1,
          scaleEnd: 0.5,
          duration: 1,
          easing: 'linear',
        },
      },
    ];
    // Head anchor drives x; the body anchor provides Py for the Y compensation.
    const deps = {
      resolveCharacterPosition: (_id: string, part?: string) =>
        part === 'head' ? { x: 0.6, y: 0.5 } : { x: 0.4, y: 0.9 },
    };

    // Worked example at progress 0.5 (linear): Z=1.5, S=1/1.5,
    // y = (0.9 - S) + (0.5 - 0.3)/1.5 ≈ 0.366667.
    const mid = computeCameraStateAtTime(timeline as any, 2.5, deps);
    expect(mid.zoom).toBeCloseTo(1.5, 6);
    expect(mid.position.x).toBeCloseTo(0.6, 6);
    expect(mid.position.y).toBeCloseTo(0.366667, 5);

    // End state latches zoomEnd.
    const done = computeCameraStateAtTime(timeline as any, 4, deps);
    expect(done.zoom).toBe(2);
    expect(done.coverage.zoom).toBe(true);
    expect(done.coverage.position).toBe(true);
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
