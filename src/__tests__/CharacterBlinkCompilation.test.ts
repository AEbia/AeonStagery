import { describe, expect, it } from 'vitest';
import { sceneStatementCompiler } from '../services/semantic-scene/SceneStatementCompiler';
import { sceneStatementDefinitionRegistry } from '../services/semantic-scene/SceneStatementDefinitionRegistry';
import { sceneDocumentCodec } from '../services/semantic-scene/SceneDocumentCodec';
import {
  computeSceneStateAtTime,
  resolveBlinkIntervalRangeMilliseconds,
} from '../engine/RuntimeSceneState';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';

describe('CharacterBlink Compilation and RuntimeSceneState (Seam 2)', () => {
  describe('SceneStatementCompiler', () => {
    it('compiles blink.intervalRange into characterBlink action params', () => {
      const scene: any = {
        schemaVersion: SCENE_SCHEMA_VERSION,
        sceneId: 'test-blink-range',
        meta: { title: 'Test Blink Range' },
        statements: [
          {
            id: 'stmt-perf',
            type: 'characterPerformance',
            time: 2.0,
            params: {
              target: 'tomori',
              blink: {
                enabled: true,
                interval: 5,
                intervalRange: 0.5,
              },
            },
          },
        ],
      };

      const compiled = sceneStatementCompiler.compile(scene);
      const blinkAction = compiled.actions.find((a) => a.action === 'characterBlink');

      expect(blinkAction).toBeDefined();
      expect(blinkAction?.params).toEqual({
        id: 'tomori',
        enabled: true,
        interval: 5,
        intervalRange: 0.5,
      });
    });

    it('cleans undefined intervalRange when omitted from source statement', () => {
      const scene: any = {
        schemaVersion: SCENE_SCHEMA_VERSION,
        sceneId: 'test-blink-no-range',
        meta: { title: 'Test Blink No Range' },
        statements: [
          {
            id: 'stmt-perf',
            type: 'characterPerformance',
            time: 1.0,
            params: {
              target: 'tomori',
              blink: {
                enabled: true,
                interval: 4,
              },
            },
          },
        ],
      };

      const compiled = sceneStatementCompiler.compile(scene);
      const blinkAction = compiled.actions.find((a) => a.action === 'characterBlink');

      expect(blinkAction).toBeDefined();
      expect(blinkAction?.params).toEqual({
        id: 'tomori',
        enabled: true,
        interval: 4,
      });
      expect('intervalRange' in (blinkAction?.params ?? {})).toBe(false);
    });
  });

  describe('RuntimeSceneState resolution', () => {
    it('converts intervalRange in seconds to intervalRangeMs in milliseconds', () => {
      expect(resolveBlinkIntervalRangeMilliseconds({ intervalRange: 0.5 })).toBe(500);
      expect(resolveBlinkIntervalRangeMilliseconds({ intervalRange: 1.2 })).toBe(1200);
      expect(resolveBlinkIntervalRangeMilliseconds({ intervalRange: 0 })).toBe(0);
      expect(resolveBlinkIntervalRangeMilliseconds({ intervalRange: -0.5 })).toBe(0);
      expect(resolveBlinkIntervalRangeMilliseconds({})).toBe(0);
      expect(resolveBlinkIntervalRangeMilliseconds({ intervalRange: NaN })).toBe(0);
    });

    it('materializes intervalRangeMs on character state at target time in computeSceneStateAtTime', () => {
      const characterScene = {
        sceneId: 'character-blink-range-state',
        meta: { title: 'Character blink state', characters: [] },
        timeline: [
          {
            action: 'addCharacter' as const,
            time: 0,
            params: { id: 'tomori', model: 'figure/tomori/model.json', enter: 'none' },
          },
          {
            action: 'characterBlink' as const,
            time: 1,
            params: { id: 'tomori', enabled: true, interval: 5, intervalRange: 0.5 },
          },
        ],
      } as any;

      const state = computeSceneStateAtTime(characterScene, 1.5);
      const tomoriBlink = state.characters.get('tomori').blink;

      expect(tomoriBlink).toEqual({
        enabled: true,
        intervalMs: 5000,
        intervalRangeMs: 500,
        startTime: 1,
      });
    });
  });

  describe('SceneStatementDefinitionRegistry and SceneDocumentCodec validation', () => {
    it('parses and preserves blink.intervalRange in characterPerformance params', () => {
      const parsed = sceneStatementDefinitionRegistry.get('characterPerformance')?.parseParams({
        target: 'tomori',
        blink: {
          enabled: true,
          interval: 5,
          intervalRange: 0.5,
        },
      }, 'statement.params');

      expect(parsed).toEqual({
        target: 'tomori',
        blink: {
          enabled: true,
          interval: 5,
          intervalRange: 0.5,
        },
      });
    });

    it('validates scene document containing blink.intervalRange via SceneDocumentCodec', () => {
      const doc = {
        schemaVersion: SCENE_SCHEMA_VERSION,
        sceneId: 'test-codec-blink-range',
        meta: { title: 'Test Codec Blink Range', characters: [{ id: 'tomori', name: 'Tomori' }] },
        statements: [
          {
            id: 'stmt_1',
            time: 0,
            type: 'characterPerformance',
            params: {
              target: 'tomori',
              blink: {
                enabled: true,
                interval: 5,
                intervalRange: 0.5,
              },
            },
          },
        ],
      };

      const validated = sceneDocumentCodec.parseAndValidate(doc);
      expect((validated.statements[0].params as any).blink).toEqual({
        enabled: true,
        interval: 5,
        intervalRange: 0.5,
      });
    });
  });
});
