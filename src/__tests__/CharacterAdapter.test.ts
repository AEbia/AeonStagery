/**
 * CharacterAdapter tests — RED (no implementation exists yet).
 *
 * Facade adapter that translates UI-level character intents into
 * engine-level Live2DManager calls. No business logic — pure delegation.
 *
 * All adapter imports resolve to files that do NOT exist yet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CharacterAdapter } from '../api/adapters/CharacterAdapter';
import { live2DManager } from '../engine/Live2DManager';
import type { CharacterConfig, CharacterTransformConfig } from '../api/types/character';

// ── Mock the engine singleton ─────────────────────────────────────

vi.mock('../engine/Live2DManager', () => {
  const mockAddCharacter = vi.fn().mockResolvedValue(undefined);
  const mockRemoveCharacter = vi.fn();
  const mockPlayMotion = vi.fn();
  const mockStopAllMotions = vi.fn();
  const mockSetExpression = vi.fn();
  const mockLookAt = vi.fn();
  const mockTransform = vi.fn();

  return {
    live2DManager: {
      addCharacter: mockAddCharacter,
      removeCharacter: mockRemoveCharacter,
      playMotion: mockPlayMotion,
      stopAllMotions: mockStopAllMotions,
      setExpression: mockSetExpression,
      lookAt: mockLookAt,
      transform: mockTransform,
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────

function makeCharacterConfig(overrides: Partial<CharacterConfig> = {}): CharacterConfig {
  return {
    position: { x: 0.5, y: 0.8 },
    scale: 0.9,
    ...overrides,
  };
}

function makeTransformConfig(overrides: Partial<CharacterTransformConfig> = {}): CharacterTransformConfig {
  return {
    duration: 0.5,
    position: { x: 0.7, y: 0.3 },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('CharacterAdapter', () => {
  let adapter: CharacterAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new CharacterAdapter();
  });

  // ── add() ──────────────────────────────────────────────────

  describe('add()', () => {
    it('delegates to live2DManager.addCharacter with id, path, and undefined config', async () => {
      await adapter.add('char1', '/models/char1.model3.json');

      expect(live2DManager.addCharacter).toHaveBeenCalledTimes(1);
      expect(live2DManager.addCharacter).toHaveBeenCalledWith(
        'char1',
        '/models/char1.model3.json',
        undefined,
      );
    });

    it('passes config through to live2DManager.addCharacter', async () => {
      const config = makeCharacterConfig({ scale: 1.2, opacity: 0.8 });

      await adapter.add('char2', '/models/char2.model3.json', config);

      expect(live2DManager.addCharacter).toHaveBeenCalledWith(
        'char2',
        '/models/char2.model3.json',
        config,
      );
    });

    it('returns a Promise (mirrors engine.addCharacter return)', async () => {
      const result = adapter.add('char3', '/models/char3.model3.json');

      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('handles characters added without config', async () => {
      await adapter.add('char4', '/models/char4.model3.json');

      expect(live2DManager.addCharacter).toHaveBeenCalledWith(
        'char4',
        '/models/char4.model3.json',
        undefined,
      );
    });
  });

  // ── remove() ───────────────────────────────────────────────

  describe('remove()', () => {
    it('delegates to live2DManager.removeCharacter with the id', async () => {
      await adapter.remove('char1');

      expect(live2DManager.removeCharacter).toHaveBeenCalledTimes(1);
      expect(live2DManager.removeCharacter).toHaveBeenCalledWith('char1');
    });

    it('removes different characters independently', async () => {
      await adapter.remove('charA');
      await adapter.remove('charB');

      expect(live2DManager.removeCharacter).toHaveBeenCalledTimes(2);
      expect(live2DManager.removeCharacter).toHaveBeenNthCalledWith(1, 'charA');
      expect(live2DManager.removeCharacter).toHaveBeenNthCalledWith(2, 'charB');
    });
  });

  // ── playMotion() ───────────────────────────────────────────

  describe('playMotion()', () => {
    it('delegates to live2DManager.playMotion with id and motionKey', () => {
      adapter.playMotion('char1', 'idle');

      expect(live2DManager.playMotion).toHaveBeenCalledTimes(1);
      expect(live2DManager.playMotion).toHaveBeenCalledWith('char1', 'idle');
    });

    it('passes different motion keys through', () => {
      adapter.playMotion('char2', 'walk');
      adapter.playMotion('char2', 'wave');

      expect(live2DManager.playMotion).toHaveBeenCalledTimes(2);
      expect(live2DManager.playMotion).toHaveBeenNthCalledWith(1, 'char2', 'walk');
      expect(live2DManager.playMotion).toHaveBeenNthCalledWith(2, 'char2', 'wave');
    });
  });

  // ── stopAllMotions() ───────────────────────────────────────

  describe('stopAllMotions()', () => {
    it('delegates to live2DManager.stopAllMotions with the character id', () => {
      adapter.stopAllMotions('char1');

      expect(live2DManager.stopAllMotions).toHaveBeenCalledTimes(1);
      expect(live2DManager.stopAllMotions).toHaveBeenCalledWith('char1');
    });

    it('passes different character ids through', () => {
      adapter.stopAllMotions('charA');
      adapter.stopAllMotions('charB');

      expect(live2DManager.stopAllMotions).toHaveBeenCalledTimes(2);
      expect(live2DManager.stopAllMotions).toHaveBeenNthCalledWith(1, 'charA');
      expect(live2DManager.stopAllMotions).toHaveBeenNthCalledWith(2, 'charB');
    });
  });

  // ── setExpression() ────────────────────────────────────────

  describe('setExpression()', () => {
    it('delegates to live2DManager.setExpression with id and expression name', () => {
      adapter.setExpression('char1', 'happy');

      expect(live2DManager.setExpression).toHaveBeenCalledTimes(1);
      expect(live2DManager.setExpression).toHaveBeenCalledWith('char1', 'happy');
    });

    it('passes different expression names', () => {
      adapter.setExpression('char1', 'sad');
      adapter.setExpression('char1', 'angry');

      expect(live2DManager.setExpression).toHaveBeenCalledTimes(2);
      expect(live2DManager.setExpression).toHaveBeenNthCalledWith(1, 'char1', 'sad');
      expect(live2DManager.setExpression).toHaveBeenNthCalledWith(2, 'char1', 'angry');
    });
  });

  // ── lookAt() ───────────────────────────────────────────────

  describe('lookAt()', () => {
    it('delegates to live2DManager.lookAt with id, x, y', () => {
      adapter.lookAt('char1', 0.5, -0.3);

      expect(live2DManager.lookAt).toHaveBeenCalledTimes(1);
      expect(live2DManager.lookAt).toHaveBeenCalledWith('char1', 0.5, -0.3, undefined);
    });

    it('passes optional duration through', () => {
      adapter.lookAt('char1', 0.8, 0.2, 1.5);

      expect(live2DManager.lookAt).toHaveBeenCalledWith('char1', 0.8, 0.2, 1.5);
    });

    it('passes zero-position lookAt through', () => {
      adapter.lookAt('char2', 0, 0);

      expect(live2DManager.lookAt).toHaveBeenCalledWith('char2', 0, 0, undefined);
    });
  });

  // ── transform() ────────────────────────────────────────────

  describe('transform()', () => {
    it('delegates to live2DManager.transform with id and config', () => {
      const config = makeTransformConfig({ position: { x: 0.3, y: 0.7 }, scale: 1.5 });

      adapter.transform('char1', config);

      expect(live2DManager.transform).toHaveBeenCalledTimes(1);
      expect(live2DManager.transform).toHaveBeenCalledWith('char1', config);
    });

    it('passes transform with rotation config', () => {
      const config = makeTransformConfig({ rotation: 45 });

      adapter.transform('char2', config);

      expect(live2DManager.transform).toHaveBeenCalledWith('char2', config);
    });

    it('passes transform with opacity config', () => {
      const config = makeTransformConfig({ opacity: 0.5 });

      adapter.transform('char3', config);

      expect(live2DManager.transform).toHaveBeenCalledWith('char3', config);
    });
  });
});
