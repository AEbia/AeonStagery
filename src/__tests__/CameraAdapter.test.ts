/**
 * CameraAdapter tests — RED (no implementation exists yet).
 *
 * Facade adapter that translates UI-level camera intents into
 * engine-level CameraController calls. No business logic — pure delegation
 * with semantic translation (e.g. focusOn → moveTo with targetCharacter).
 *
 * All adapter imports resolve to files that do NOT exist yet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CameraAdapter } from '../api/adapters/CameraAdapter';
import { cameraController } from '../engine/CameraController';
import type { CameraMotionConfig, CameraKeyframe, CameraPathConfig, CameraShakeConfig } from '../api/types/camera';

// ── Mock the engine singleton ─────────────────────────────────────

vi.mock('../engine/CameraController', () => {
  const mockMoveTo = vi.fn();
  const mockExecuteMotion = vi.fn();
  const mockCreatePath = vi.fn().mockReturnValue({ _gsapMock: true } as any);
  const mockShake = vi.fn();
  const mockReset = vi.fn();
  const mockGetState = vi.fn().mockReturnValue({
    position: { x: 0.5, y: 0.5 },
    zoom: 1,
    rotation: 0,
  });

  return {
    cameraController: {
      moveTo: mockMoveTo,
      executeMotion: mockExecuteMotion,
      createPath: mockCreatePath,
      shake: mockShake,
      reset: mockReset,
      getState: mockGetState,
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────

function makeMotionConfig(overrides: Partial<CameraMotionConfig> = {}): CameraMotionConfig {
  return {
    move: 'push',
    easing: 'smooth',
    duration: 2,
    ...overrides,
  };
}

function makeKeyframes(): CameraKeyframe[] {
  return [
    { time: 0, position: { x: 0.2, y: 0.5 }, zoom: 1 },
    { time: 3, position: { x: 0.8, y: 0.5 }, zoom: 1.5 },
  ];
}

// ── Tests ────────────────────────────────────────────────────────

describe('CameraAdapter', () => {
  let adapter: CameraAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new CameraAdapter();
  });

  // ── focusOn() ───────────────────────────────────────────────

  describe('focusOn()', () => {
    it('delegates to cameraController.moveTo with targetCharacter and default targetPart', () => {
      adapter.focusOn('char1');

      expect(cameraController.moveTo).toHaveBeenCalledTimes(1);
      expect(cameraController.moveTo).toHaveBeenCalledWith({
        targetCharacter: 'char1',
        targetPart: 'center',
        duration: 1,
        ease: 'power2.inOut',
      });
    });

    it('passes the explicit part through as targetPart', () => {
      adapter.focusOn('char1', 'head');

      expect(cameraController.moveTo).toHaveBeenCalledWith({
        targetCharacter: 'char1',
        targetPart: 'head',
        duration: 1,
        ease: 'power2.inOut',
      });
    });

    it('uses "chest" as targetPart when specified', () => {
      adapter.focusOn('char2', 'chest');

      expect(cameraController.moveTo).toHaveBeenCalledWith({
        targetCharacter: 'char2',
        targetPart: 'chest',
        duration: 1,
        ease: 'power2.inOut',
      });
    });
  });

  // ── executeMotion() ────────────────────────────────────────

  describe('executeMotion()', () => {
    it('delegates to cameraController.executeMotion with the full config', () => {
      const config = makeMotionConfig({ move: 'pan', easing: 'accelerate' });

      adapter.executeMotion(config);

      expect(cameraController.executeMotion).toHaveBeenCalledTimes(1);
      expect(cameraController.executeMotion).toHaveBeenCalledWith(config);
    });

    it('passes complex motion configs through unchanged', () => {
      const config = makeMotionConfig({
        move: 'dolly',
        easing: 'overshoot',
        focus: { character: 'char1', part: 'head' },
        zoom: 1.8,
        duration: 4,
      });

      adapter.executeMotion(config);

      expect(cameraController.executeMotion).toHaveBeenCalledWith(config);
    });
  });

  // ── createPath() ───────────────────────────────────────────

  describe('createPath()', () => {
    it('delegates to cameraController.createPath with keyframes', () => {
      const kfs = makeKeyframes();

      adapter.createPath(kfs);

      expect(cameraController.createPath).toHaveBeenCalledTimes(1);
      expect(cameraController.createPath).toHaveBeenCalledWith(kfs, {});
    });

    it('passes optional path config through to the engine', () => {
      const kfs = makeKeyframes();
      const config: CameraPathConfig = { loop: true, startTime: 2 };

      adapter.createPath(kfs, config);

      expect(cameraController.createPath).toHaveBeenCalledWith(kfs, config);
    });

    it('returns a path ID (string)', () => {
      const kfs = makeKeyframes();
      const result = adapter.createPath(kfs);

      // The adapter generates a unique ID for the created path
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ── shake() ────────────────────────────────────────────────

  describe('shake()', () => {
    it('delegates to cameraController.shake with no config', () => {
      adapter.shake();

      expect(cameraController.shake).toHaveBeenCalledTimes(1);
      expect(cameraController.shake).toHaveBeenCalledWith({});
    });

    it('delegates to cameraController.shake with partial config', () => {
      const config: CameraShakeConfig = { intensity: 0.7, duration: 1.5 };

      adapter.shake(config);

      expect(cameraController.shake).toHaveBeenCalledWith(config);
    });

    it('passes full shake config through', () => {
      const config: CameraShakeConfig = {
        intensity: 0.9,
        frequency: 20,
        duration: 2,
        decay: true,
        direction: 'horizontal',
      };

      adapter.shake(config);

      expect(cameraController.shake).toHaveBeenCalledWith(config);
    });
  });

  // ── reset() ────────────────────────────────────────────────

  describe('reset()', () => {
    it('delegates to cameraController.reset with defaults', () => {
      adapter.reset();

      expect(cameraController.reset).toHaveBeenCalledTimes(1);
      expect(cameraController.reset).toHaveBeenCalledWith(1, 'power2.inOut');
    });

    it('passes explicit duration and ease through', () => {
      adapter.reset(2, 'linear');

      expect(cameraController.reset).toHaveBeenCalledWith(2, 'linear');
    });

    it('passes only duration when ease is omitted', () => {
      adapter.reset(3);

      expect(cameraController.reset).toHaveBeenCalledWith(3, 'power2.inOut');
    });
  });
});
