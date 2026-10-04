import { describe, expect, it } from 'vitest';
import {
  migrateSceneV3ToV5,
  migrateSceneV4ToV5,
  validateV4Stage,
  validateV5Stage,
} from '../services/semantic-scene/SceneV4ToV5Migration';
import { SceneDocumentCodec } from '../services/semantic-scene/SceneDocumentCodec';
import { UnknownSceneDiscriminatorError } from '../services/semantic-scene/SceneDocumentContractErrors';

function makeV4Scene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 4,
    sceneId: 'scene-v4',
    meta: { title: 'Scene V4' },
    statements: [
      {
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: {
          text: 'Hello from v4',
          durationSeconds: 2,
        },
      },
    ],
    ...overrides,
  };
}

function makeV3Scene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    sceneId: 'scene-v3',
    meta: { title: 'Scene V3', durationSeconds: 5 },
    statements: [
      {
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: {
          text: 'Hello from v3',
          durationSeconds: 2,
        },
      },
    ],
    ...overrides,
  };
}

describe('SceneV4ToV5Migration', () => {
  describe('migrateSceneV4ToV5', () => {
    it('migrates a valid v4 scene to v5 preserving all recognized and unknown properties', () => {
      const v4Scene = makeV4Scene({
        futureRootField: { test: true },
        meta: {
          title: 'Scene V4 with Meta',
          durationSeconds: 10,
          customMeta: 'preserved',
        },
        statements: [
          {
            id: 'dialogue-1',
            time: 0,
            type: 'dialogue',
            futureStatementProp: 123,
            params: {
              text: 'Hello v4',
              durationSeconds: 3,
              futureParam: 'preserved-param',
            },
            companions: [
              {
                id: 'camera-1',
                anchor: 'start',
                offset: 0,
                type: 'camera',
                params: {
                  mode: 'focus',
                  target: 'hero',
                },
              },
            ],
          },
        ],
      });

      const { document, warnings } = migrateSceneV4ToV5(v4Scene);
      expect(warnings).toEqual([]);
      expect(document).toEqual({
        ...v4Scene,
        schemaVersion: 5,
      });

      // Verify that original input is untouched
      expect(v4Scene.schemaVersion).toBe(4);
    });

    it('repairs legacy v4 custom motion segments and reports warnings', () => {
      const v4Scene = makeV4Scene({
        statements: [
          {
            id: 'char-1',
            time: 0,
            type: 'characterPerformance',
            params: {
              target: 'tomori',
              motion: {
                kind: 'custom',
                durationSeconds: 2,
                fadeInSeconds: 0,
                derivedFrom: { key: 'wave' },
                tracks: [
                  {
                    parameterId: 'PARAM_A',
                    keyframes: [
                      { time: 0, value: 0 }, // missing segment on non-last keyframe
                      { time: 1, value: 1 },
                    ],
                  },
                ],
              },
            },
          },
        ],
      });

      const { document, warnings } = migrateSceneV4ToV5(v4Scene);
      expect((document as Record<string, unknown>).schemaVersion).toBe(5);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('implicit linear keyframe segment');
    });

    it('rejects invalid inputs', () => {
      expect(() => migrateSceneV4ToV5(null)).toThrow('migrateSceneV4ToV5 expects an object input');
      expect(() => migrateSceneV4ToV5('string')).toThrow('migrateSceneV4ToV5 expects an object input');
      expect(() => migrateSceneV4ToV5({ schemaVersion: 3 })).toThrow('migrateSceneV4ToV5 expects schemaVersion 4, received 3');
      expect(() => migrateSceneV4ToV5({ schemaVersion: 5 })).toThrow('migrateSceneV4ToV5 expects schemaVersion 4, received 5');
      expect(() => migrateSceneV4ToV5({ schemaVersion: 4 })).toThrow('migrateSceneV4ToV5 expects a statements array on schemaVersion 4 scene documents');
    });

    it('fails detached validation if v4 document contains unknown statement discriminators', () => {
      const invalidV4 = makeV4Scene({
        statements: [
          {
            id: 'unknown-1',
            time: 0,
            type: 'futureUnsupportedType',
            params: {},
          },
        ],
      });

      expect(() => migrateSceneV4ToV5(invalidV4)).toThrow(UnknownSceneDiscriminatorError);
      // Original object is untouched
      expect(invalidV4.schemaVersion).toBe(4);
    });
  });

  describe('migrateSceneV3ToV5', () => {
    it('composes v3->v4 and v4->v5 migrations into a single deterministic v5 document', () => {
      const v3Scene = makeV3Scene({
        statements: [
          {
            id: 'perf-1',
            time: 0,
            type: 'characterPerformance',
            params: {
              target: 'tomori',
              motion: 'wave',
              loop: true,
              priority: 2,
              durationSeconds: 4,
            },
          },
          {
            id: 'clip-1',
            time: 1,
            type: 'live2dParameterClip',
            params: { durationSeconds: 2 },
          },
        ],
      });

      const { document, warnings } = migrateSceneV3ToV5(v3Scene);
      const doc = document as Record<string, unknown>;
      expect(doc.schemaVersion).toBe(5);

      // live2dParameterClip statement was dropped
      const stmts = doc.statements as Array<Record<string, unknown>>;
      expect(stmts).toHaveLength(1);
      expect(stmts[0].id).toBe('perf-1');
      expect((stmts[0].params as Record<string, unknown>).motion).toEqual({ kind: 'resource', key: 'wave' });

      // Warnings from v3->v4 migration are aggregated
      expect(warnings.some((w) => w.includes('Removed live2dParameterClip statement "clip-1"'))).toBe(true);
      expect(warnings.some((w) => w.includes('Dropped characterPerformance loop=true'))).toBe(true);
      expect(warnings.some((w) => w.includes('Dropped characterPerformance priority=2'))).toBe(true);

      // Original v3 input is untouched
      expect(v3Scene.schemaVersion).toBe(3);
    });

    it('rejects invalid v3 inputs', () => {
      expect(() => migrateSceneV3ToV5(null)).toThrow('migrateSceneV3ToV5 expects an object input');
      expect(() => migrateSceneV3ToV5({ schemaVersion: 4 })).toThrow('migrateSceneV3ToV5 expects schemaVersion 3, received 4');
      expect(() => migrateSceneV3ToV5({ schemaVersion: 3 })).toThrow('migrateSceneV3ToV5 expects a statements array on schemaVersion 3 scene documents');
    });

    it('fails detached validation if v3 scene contains invalid statements', () => {
      const invalidV3 = makeV3Scene({
        statements: [
          {
            id: 'dialogue-1',
            time: 0,
            type: 'dialogue',
            params: {
              text: 'Missing text or invalid duration',
              durationSeconds: 'not-a-number',
            },
          },
        ],
      });

      expect(() => migrateSceneV3ToV5(invalidV3)).toThrow();
      expect(invalidV3.schemaVersion).toBe(3);
    });
  });

  describe('stage validation helpers', () => {
    const codec = new SceneDocumentCodec();

    it('validateV4Stage succeeds for valid v4 shapes and throws for non-objects', () => {
      expect(() => validateV4Stage(makeV4Scene(), codec)).not.toThrow();
      expect(() => validateV4Stage('not-object', codec)).toThrow('Detached v4 stage validation expects an object');
    });

    it('validateV5Stage returns frozen SceneDocumentV5 projection', () => {
      const projection = validateV5Stage(makeV4Scene({ schemaVersion: 5 }), codec);
      expect(projection.schemaVersion).toBe(5);
      expect(Object.isFrozen(projection)).toBe(true);
      expect(() => validateV5Stage('not-object', codec)).toThrow('Detached v5 stage validation expects an object');
    });
  });
});
