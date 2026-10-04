/**
 * StageAdapter tests — RED (no implementation exists yet).
 *
 * Facade adapter that translates UI-level stage intents into
 * engine-level StageManager calls. No business logic — pure delegation
 * with sensible defaults (e.g. transition defaults to 'none').
 *
 * All adapter imports resolve to files that do NOT exist yet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StageAdapter } from '../api/adapters/StageAdapter';
import { stageManager } from '../engine/StageManager';
import { lightingSystem } from '../engine/LightingSystem';

// ── Mock the engine singleton ─────────────────────────────────────

vi.mock('../engine/StageManager', () => {
  const mockInit = vi.fn().mockResolvedValue(undefined);
  const mockSetBackground = vi.fn().mockResolvedValue(undefined);
  const mockGetLayer = vi.fn().mockReturnValue({ _mockLayer: true });
  const mockGetWidth = vi.fn().mockReturnValue(1920);
  const mockGetHeight = vi.fn().mockReturnValue(1080);
  const mockGetPreviewResolution = vi.fn().mockReturnValue(1);
  const mockSetPreviewResolution = vi.fn();

  return {
    stageManager: {
      init: mockInit,
      setBackground: mockSetBackground,
      getLayer: mockGetLayer,
      getWidth: mockGetWidth,
      getHeight: mockGetHeight,
      getPreviewResolution: mockGetPreviewResolution,
      setPreviewResolution: mockSetPreviewResolution,
    },
  };
});

vi.mock('../engine/LightingSystem', () => ({
  lightingSystem: {
    init: vi.fn(),
  },
}));

// ── Tests ────────────────────────────────────────────────────────

describe('StageAdapter', () => {
  let adapter: StageAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new StageAdapter();
  });

  describe('mount()', () => {
    it('delegates to stageManager.init with the provided container', async () => {
      const container = {} as HTMLElement;

      await adapter.mount(container);

      expect(stageManager.init).toHaveBeenCalledTimes(1);
      expect(stageManager.init).toHaveBeenCalledWith(container);
    });

    it('initializes lighting filters after the stage mounts', async () => {
      const container = {} as HTMLElement;

      await adapter.mount(container);

      expect(lightingSystem.init).toHaveBeenCalledTimes(1);
    });
  });

  // ── setBackground() ────────────────────────────────────────

  describe('setBackground()', () => {
    it('delegates to stageManager.setBackground with path and default transition "none"', async () => {
      await adapter.setBackground('/assets/bg/stage.png');

      expect(stageManager.setBackground).toHaveBeenCalledTimes(1);
      expect(stageManager.setBackground).toHaveBeenCalledWith(
        '/assets/bg/stage.png',
        { transition: 'none' },
      );
    });

    it('passes custom options through to stageManager.setBackground', async () => {
      await adapter.setBackground('/assets/bg/night.png', { transition: 'fade' });

      expect(stageManager.setBackground).toHaveBeenCalledWith(
        '/assets/bg/night.png',
        { transition: 'fade' },
      );
    });

    it('merges partial options with defaults', async () => {
      // The adapter should merge user options with its defaults
      await adapter.setBackground('/assets/bg/sunset.png', {});

      expect(stageManager.setBackground).toHaveBeenCalledWith(
        '/assets/bg/sunset.png',
        { transition: 'none' },
      );
    });

    it('returns a Promise (mirrors engine.setBackground return)', async () => {
      const result = adapter.setBackground('/assets/bg/test.png');

      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  // ── getLayer() ─────────────────────────────────────────────

  describe('getLayer()', () => {
    it('delegates to stageManager.getLayer for the characters layer', () => {
      const layer = adapter.getLayer('characters');

      expect(stageManager.getLayer).toHaveBeenCalledTimes(1);
      expect(stageManager.getLayer).toHaveBeenCalledWith('characters');
      expect(layer).toEqual({ _mockLayer: true });
    });

    it('delegates to stageManager.getLayer for the background layer', () => {
      adapter.getLayer('background');

      expect(stageManager.getLayer).toHaveBeenCalledWith('background');
    });

    it('delegates to stageManager.getLayer for the effects layer', () => {
      adapter.getLayer('effects');

      expect(stageManager.getLayer).toHaveBeenCalledWith('effects');
    });

    it('delegates to stageManager.getLayer for the subtitle layer', () => {
      adapter.getLayer('subtitle');

      expect(stageManager.getLayer).toHaveBeenCalledWith('subtitle');
    });
  });

  // ── getWidth() ─────────────────────────────────────────────

  describe('getWidth()', () => {
    it('returns stageManager.getWidth() value', () => {
      const width = adapter.getWidth();

      expect(stageManager.getWidth).toHaveBeenCalledTimes(1);
      expect(width).toBe(1920);
    });

    it('returns a number', () => {
      expect(typeof adapter.getWidth()).toBe('number');
    });
  });

  // ── getHeight() ────────────────────────────────────────────

  describe('getHeight()', () => {
    it('returns stageManager.getHeight() value', () => {
      const height = adapter.getHeight();

      expect(stageManager.getHeight).toHaveBeenCalledTimes(1);
      expect(height).toBe(1080);
    });

    it('returns a number', () => {
      expect(typeof adapter.getHeight()).toBe('number');
    });
  });

  describe('preview resolution', () => {
    it('reads the current stage preview resolution', () => {
      expect(adapter.getPreviewResolution()).toBe(1);
      expect(stageManager.getPreviewResolution).toHaveBeenCalledTimes(1);
    });

    it('delegates preview resolution changes without persistence', () => {
      adapter.setPreviewResolution(0.5);

      expect(stageManager.setPreviewResolution).toHaveBeenCalledWith(0.5);
    });
  });

  // ── Consistency ───────────────────────────────────────────

  describe('dimensions consistency', () => {
    it('width and height are independent calls', () => {
      const w = adapter.getWidth();
      const h = adapter.getHeight();

      expect(stageManager.getWidth).toHaveBeenCalledTimes(1);
      expect(stageManager.getHeight).toHaveBeenCalledTimes(1);
      expect(w).toBe(1920);
      expect(h).toBe(1080);
    });
  });
});
