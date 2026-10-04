import { beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';

const live2DMocks = vi.hoisted(() => ({
  getModel: vi.fn(),
  getContainer: vi.fn(),
  removeCharacter: vi.fn(),
}));

vi.mock('../engine/Live2DManager', () => ({
  live2DManager: live2DMocks,
}));

import AnimationDirector from '../engine/AnimationDirector';

describe('AnimationDirector public behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    live2DMocks.getModel.mockReturnValue(undefined);
    live2DMocks.getContainer.mockReturnValue(undefined);
    gsap.globalTimeline.clear();
  });

  it('fades an entering character from transparent to its target opacity', () => {
    const director = new AnimationDirector();
    const proxy = { x: 320, y: 240, scale: 1, opacity: 1 };
    const timeline = director.characterEnter(
      'tomori',
      'fadeIn',
      1,
      'linear',
      proxy,
      0.8,
    );

    timeline.pause(0);
    expect(proxy.opacity).toBe(0);

    timeline.seek(0.5, false);
    expect(proxy.opacity).toBeCloseTo(0.4);

    timeline.seek(1, false);
    expect(proxy.opacity).toBeCloseTo(0.8);
  });

  it('slides an entering character from the left using its model width', () => {
    live2DMocks.getModel.mockReturnValue({ width: 800 });
    const director = new AnimationDirector();
    const proxy = { x: 1000, y: 540, scale: 1, opacity: 1 };
    const timeline = director.characterEnter('tomori', 'slideFromLeft', 1, 'linear', proxy);

    timeline.pause(0);
    expect(proxy).toMatchObject({ x: 600, opacity: 0 });

    timeline.seek(0.5, false);
    expect(proxy.x).toBeCloseTo(800);
    expect(proxy.opacity).toBeCloseTo(0.5);

    timeline.seek(1, false);
    expect(proxy).toMatchObject({ x: 1000, opacity: 1 });
  });

  it('zooms an entering proxy from thirty percent of its final scale', () => {
    const director = new AnimationDirector();
    const proxy = { x: 960, y: 540, scale: 2, opacity: 1 };
    const timeline = director.characterEnter('tomori', 'zoomIn', 1, 'linear', proxy);

    timeline.pause(0);
    expect(proxy).toMatchObject({ scale: 0.6, opacity: 0 });

    timeline.seek(0.5, false);
    expect(proxy).toMatchObject({ scale: 1.3, opacity: 0.5 });

    timeline.seek(1, false);
    expect(proxy).toMatchObject({ scale: 2, opacity: 1 });
  });

  it('drops an entering character from a model-height offset', () => {
    live2DMocks.getModel.mockReturnValue({ height: 1000 });
    const director = new AnimationDirector();
    const proxy = { x: 960, y: 500, scale: 1, opacity: 1 };
    const timeline = director.characterEnter('tomori', 'dropIn', 1, 'linear', proxy);

    timeline.pause(0);
    expect(proxy).toMatchObject({ y: 0, opacity: 0 });

    timeline.seek(0.5, false);
    expect(proxy.y).toBeGreaterThanOrEqual(0);
    expect(proxy.y).toBeLessThanOrEqual(500);
    expect(proxy.opacity).toBeGreaterThanOrEqual(0);
    expect(proxy.opacity).toBeLessThanOrEqual(1);

    timeline.seek(1, false);
    expect(proxy).toMatchObject({ y: 500, opacity: 1 });
  });

  it('applies an entering character immediately when the entrance is none', () => {
    const director = new AnimationDirector();
    const proxy = { x: 960, y: 540, scale: 1, opacity: 0 };
    const timeline = director.characterEnter('tomori', 'none', 1, 'linear', proxy, 0.65);

    timeline.pause(0);

    expect(proxy.opacity).toBeCloseTo(0.65);
    expect(timeline.duration()).toBe(0);
  });

  it('zooms an exiting character out before removing it', () => {
    const director = new AnimationDirector();
    const proxy = { x: 960, y: 540, scale: 2, opacity: 1 };
    const timeline = director.characterExit('tomori', 'zoomOut', 1, 'linear', proxy);

    timeline.pause(0);
    timeline.seek(0.5, false);
    expect(proxy).toMatchObject({ scale: 1, opacity: 0.5 });
    expect(live2DMocks.removeCharacter).not.toHaveBeenCalled();

    timeline.seek(1, false);
    expect(proxy).toMatchObject({ scale: 0, opacity: 0 });
    expect(live2DMocks.removeCharacter).toHaveBeenCalledWith('tomori');
  });

  it('dissolves an exiting proxy while expanding it slightly', () => {
    const director = new AnimationDirector();
    const proxy = { x: 960, y: 540, scale: 2, opacity: 1 };
    const timeline = director.characterExit('tomori', 'dissolve', 1, 'linear', proxy);

    timeline.pause(0);
    expect(timeline.duration()).toBeCloseTo(1.5);

    timeline.seek(0.75, false);
    expect(proxy.opacity).toBeGreaterThan(0);
    expect(proxy.opacity).toBeLessThan(1);
    expect(proxy.scale).toBeGreaterThan(2);
    expect(proxy.scale).toBeLessThan(2.2);
    expect(live2DMocks.removeCharacter).not.toHaveBeenCalled();

    timeline.seek(1.5, false);
    expect(proxy).toMatchObject({ scale: 2.2, opacity: 0 });
    expect(live2DMocks.removeCharacter).toHaveBeenCalledWith('tomori');
  });

  it('removes an exiting character immediately when the exit preset is none', () => {
    const director = new AnimationDirector();
    const timeline = director.characterExit('tomori', 'none', 1, 'linear', {
      x: 960,
      y: 540,
      scale: 1,
      opacity: 1,
    });

    timeline.pause(0);
    expect(live2DMocks.removeCharacter).not.toHaveBeenCalled();

    timeline.seek(0.001, false);
    expect(live2DMocks.removeCharacter).toHaveBeenCalledWith('tomori');
    expect(timeline.duration()).toBeCloseTo(0.001, 6);
  });

  it('moves a character to normalized coordinates on the stage', () => {
    const container = { x: 0, y: 0 };
    live2DMocks.getContainer.mockReturnValue(container);
    const director = new AnimationDirector();
    const tween = director.characterMoveTo('tomori', [0.25, 0.75], 1, 'linear');

    tween.pause(0);
    tween.seek(0.5, false);
    expect(container).toMatchObject({ x: 240, y: 405 });

    tween.seek(1, false);
    expect(container).toMatchObject({ x: 480, y: 810 });
  });

  it('preserves a horizontally flipped sign while scaling a character', () => {
    const model = { scale: { x: -1, y: 1 } };
    live2DMocks.getModel.mockReturnValue(model);
    const director = new AnimationDirector();
    const tween = director.characterScale('tomori', 1.5, 1, 'linear');

    tween.pause(0);
    tween.seek(0.5, false);
    expect(model.scale).toMatchObject({ x: -1.25, y: 1.25 });

    tween.seek(1, false);
    expect(model.scale).toMatchObject({ x: -1.5, y: 1.5 });
  });

  it('fades a loaded character model to the requested opacity', () => {
    const model = { alpha: 1 };
    live2DMocks.getModel.mockReturnValue(model);
    const director = new AnimationDirector();
    const tween = director.characterFade('tomori', 0.35, 1, 'linear');

    tween.pause(0);
    tween.seek(0.5, false);
    expect(model.alpha).toBeCloseTo(0.675);

    tween.seek(1, false);
    expect(model.alpha).toBeCloseTo(0.35);
  });

  it('returns safe no-op tweens when a character model is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const director = new AnimationDirector();

    const scaleTween = director.characterScale('missing', 1.5);
    const fadeTween = director.characterFade('missing', 0.5);

    expect(scaleTween.duration()).toBe(0);
    expect(fadeTween.duration()).toBe(0);
    expect(warn).toHaveBeenCalledWith('[AnimationDirector] Character "missing" not found for scale');
    expect(warn).toHaveBeenCalledWith('[AnimationDirector] Character "missing" not found for fade');
    warn.mockRestore();
  });

  it('registers and plays a custom preset through its public registry', () => {
    const director = new AnimationDirector();
    const target = { opacity: 1 };
    const config = { duration: 0.75, color: '#fff' };
    const presetTimeline = gsap.timeline().to({}, { duration: 0.75 });
    const factory = vi.fn(() => presetTimeline);

    director.registerPreset('pulse', factory);
    const result = director.playPreset('pulse', target, config);

    expect(result).toBe(presetTimeline);
    expect(factory).toHaveBeenCalledWith(target, config);
  });

  it('returns null when a custom preset is not registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const director = new AnimationDirector();

    expect(director.playPreset('missing', {}, {})).toBeNull();
    expect(warn).toHaveBeenCalledWith('[AnimationDirector] Preset "missing" not found');
    warn.mockRestore();
  });

  it('composes and controls animations on the master timeline', () => {
    const director = new AnimationDirector();
    const child = director.createTimeline('intro');
    child.to({}, { duration: 0.25 });
    const target = { opacity: 1 };

    director.addTween(1, target, { opacity: 0.2, duration: 0.5, ease: 'linear' });

    expect(director.getMasterTimeline().getChildren(false, false, true)).toContain(child);
    expect(director.getDuration()).toBeCloseTo(1.5, 6);

    director.seek(1.25);
    expect(target.opacity).toBeCloseTo(0.6);

    director.pause();
    expect(director.getMasterTimeline().paused()).toBe(true);
    director.play();
    expect(director.getMasterTimeline().paused()).toBe(false);

    const resetTimeline = director.resetMasterTimeline();
    expect(director.getMasterTimeline()).toBe(resetTimeline);
    expect(director.getDuration()).toBe(0);
  });
});
