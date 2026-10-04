import { describe, expect, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  SCENE_SCHEMA_VERSION_V4,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import {
  sceneDocumentCodec,
  sceneStatementCompiler,
} from '../services/semantic-scene';
import { migrateSceneV3ToV4, repairLegacyV4CustomMotionSegments } from '../services/semantic-scene/SceneV3ToV4Migration';

function makeV4Document(overrides: Partial<CurrentSceneDocument> = {}): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_v4_canonical',
    meta: {
      title: 'Canonical V4',
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [
      {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
      },
    ],
    ...overrides,
  };
}

function makeV3Document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    sceneId: 'scene_v3_dev',
    meta: { title: 'Dev V3', characters: [{ id: 'tomori', name: 'Tomori' }] },
    statements: [],
    ...overrides,
  };
}

function makeV3Performance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeV3Document({
    statements: [
      {
        id: 'perf_1',
        time: 0,
        type: 'characterPerformance',
        params: {
          target: 'tomori',
          ...overrides,
        },
      },
    ],
  });
}

function makeV3CustomMotion(): Record<string, unknown> {
  return {
    kind: 'custom',
    durationSeconds: 5,
    fadeInSeconds: 0,
    derivedFrom: { key: 'wave' },
    tracks: [{
      parameterId: 'PARAM_A',
      keyframes: [{ time: 0, value: 0 }],
    }],
  };
}

describe('scene v3 to v4 migration', () => {
  it('returns a canonical v4 document unchanged with no warnings', () => {
    const input = makeV4Document();
    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([]);
    expect(result.document).toEqual(input);
  });

  it('migrates a bare-string motion to the resource union without warnings', () => {
    const input = makeV3Performance({ motion: 'wave' });
    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([]);
    expect(result.document.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(result.document.statements[0].params).toEqual({
      target: 'tomori',
      motion: { kind: 'resource', key: 'wave' },
    });
  });

  it('normalizes a kind-less motion record into the resource branch', () => {
    const input = makeV3Performance({ motion: { key: 'wave', fadeInSeconds: 0.3 } });
    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([]);
    expect(result.document.statements[0].params).toEqual({
      target: 'tomori',
      motion: { kind: 'resource', key: 'wave', fadeInSeconds: 0.3 },
    });
  });

  it('passes a kind: custom motion through untouched', () => {
    const motion = {
      kind: 'custom',
      durationSeconds: 5,
      fadeInSeconds: 0.5,
      derivedFrom: { key: 'wave' },
      tracks: [{
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: 5, value: 10 },
        ],
      }],
    };
    const input = makeV3Performance({ motion });
    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([]);
    const params = result.document.statements[0].params as { motion?: unknown };
    expect(params.motion).toEqual(motion);
  });

  it('completes v3 custom motion keyframes to the v4 canonical segment shape', () => {
    // The v3-era codec tolerated missing segments on non-last keyframes and
    // stripped a segment on the last keyframe; the strict v4 contract rejects
    // both, so the migration must complete the legacy shape before validation.
    const input = makeV3Performance({
      motion: {
        kind: 'custom',
        durationSeconds: 2,
        fadeInSeconds: 0.3,
        derivedFrom: { key: 'wave' },
        tracks: [{
          parameterId: 'PARAM_ANGLE_X',
          keyframes: [
            { time: 0, value: 0 },
            { time: 1, value: 10, segment: { type: 'stepped' } },
            { time: 2, value: 5, segment: { type: 'linear' } },
          ],
        }],
      },
    });
    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([]);
    const params = result.document.statements[0].params as { motion?: unknown };
    expect(params.motion).toEqual({
      kind: 'custom',
      durationSeconds: 2,
      fadeInSeconds: 0.3,
      derivedFrom: { key: 'wave' },
      tracks: [{
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: 1, value: 10, segment: { type: 'stepped' } },
          { time: 2, value: 5 },
        ],
      }],
    });
  });

  it('folds a performance durationSeconds that determined the scene end into meta.durationSeconds', () => {
    const input = makeV3Document({
      statements: [
        {
          id: 'line_1',
          time: 0,
          type: 'dialogue',
          params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 1 },
        },
        {
          id: 'perf_1',
          time: 2,
          type: 'characterPerformance',
          params: { target: 'tomori', motion: 'wave', durationSeconds: 5 },
        },
      ],
    });
    const oldSceneEnd = 7;

    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.document.meta.durationSeconds).toBe(oldSceneEnd);
    expect(result.document.statements[1].params).toEqual({
      target: 'tomori',
      motion: { kind: 'resource', key: 'wave' },
    });
    expect(sceneStatementCompiler.compile(result.document).durationSeconds).toBe(oldSceneEnd);
  });

  it('takes the longer of top-level durationSeconds and custom motion duration for the scene end', () => {
    const input = makeV3Document({
      statements: [{
        id: 'perf_1',
        time: 10,
        type: 'characterPerformance',
        params: {
          target: 'tomori',
          durationSeconds: 2,
          motion: makeV3CustomMotion(),
        },
      }],
    });

    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([]);
    expect(result.document.meta.durationSeconds).toBe(15);
    expect(result.document.statements[0].params).toEqual({
      target: 'tomori',
      motion: makeV3CustomMotion(),
    });
    expect(sceneStatementCompiler.compile(result.document).durationSeconds).toBe(15);
  });

  it('counts custom motion duration for the scene end when v3 params have no top-level durationSeconds', () => {
    const input = makeV3Document({
      statements: [{
        id: 'perf_1',
        time: 10,
        type: 'characterPerformance',
        params: { target: 'tomori', motion: makeV3CustomMotion() },
      }],
    });

    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([]);
    expect(result.document.meta.durationSeconds).toBe(15);
    expect(sceneStatementCompiler.compile(result.document).durationSeconds).toBe(15);
  });

  it('counts custom motion duration for a dialogue companion scene end', () => {
    const input = makeV3Document({
      statements: [{
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
        companions: [{
          id: 'comp_1',
          anchor: 'start',
          offset: 0,
          type: 'characterPerformance',
          params: { target: 'tomori', motion: makeV3CustomMotion() },
        }],
      }],
    });

    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([]);
    expect(result.document.meta.durationSeconds).toBe(5);
    expect(sceneStatementCompiler.compile(result.document).durationSeconds).toBe(5);
  });

  it('rejects a strict v4 document with top-level durationSeconds on characterPerformance params', () => {
    expect(() => sceneDocumentCodec.parseAndValidateWithWarnings({
      schemaVersion: SCENE_SCHEMA_VERSION_V4,
      sceneId: 'scene_v4_strict',
      meta: { title: 'Strict' },
      statements: [{
        id: 'perf_1',
        time: 0,
        type: 'characterPerformance',
        params: { target: 'tomori', motion: { kind: 'resource', key: 'wave' }, durationSeconds: 5 },
      }],
    })).toThrow(/Unknown field at .*params\.durationSeconds/);
  });

  it('rejects a strict v4 document with a bare-string motion', () => {
    expect(() => sceneDocumentCodec.parseAndValidateWithWarnings({
      schemaVersion: SCENE_SCHEMA_VERSION_V4,
      sceneId: 'scene_v4_strict',
      meta: { title: 'Strict' },
      statements: [{
        id: 'perf_1',
        time: 0,
        type: 'characterPerformance',
        params: { target: 'tomori', motion: 'wave' },
      }],
    })).toThrow(/Expected object at .*motion/);
  });

  it('keeps a pre-existing larger explicit meta.durationSeconds', () => {
    const input = makeV3Document({
      meta: { title: 'Dev V3', durationSeconds: 100 },
      statements: [{
        id: 'perf_1',
        time: 2,
        type: 'characterPerformance',
        params: { target: 'tomori', motion: 'wave', durationSeconds: 5 },
      }],
    });

    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.document.meta.durationSeconds).toBe(100);
  });

  it('silently drops default loop: false and priority: 3', () => {
    const input = makeV3Performance({ motion: 'wave', loop: false, priority: 3 });
    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([]);
    expect(result.document.statements[0].params).toEqual({
      target: 'tomori',
      motion: { kind: 'resource', key: 'wave' },
    });
  });

  it('drops non-default loop and priority with the exact migration warnings', () => {
    const input = makeV3Performance({ motion: 'wave', loop: true, priority: 5 });
    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([
      'Dropped characterPerformance loop=true on "perf_1": v4 motions run once',
      'Dropped characterPerformance priority=5 on "perf_1": v4 uses deterministic timeline takeover',
    ]);
    expect(result.document.statements[0].params).toEqual({
      target: 'tomori',
      motion: { kind: 'resource', key: 'wave' },
    });
  });

  it('removes live2dParameterClip statements and companions and folds their scene-end contribution', () => {
    const input = makeV3Document({
      statements: [
        {
          id: 'dlg_1',
          time: 0,
          type: 'dialogue',
          params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
          companions: [
            {
              id: 'clip_comp',
              anchor: 'start',
              offset: 0,
              type: 'live2dParameterClip',
              params: {
                target: 'tomori',
                source: {
                  kind: 'inline',
                  animation: {
                    tracks: [{
                      parameterId: 'PARAM_A',
                      keyframes: [{ time: 0, value: 0 }, { time: 4, value: 1 }],
                    }],
                  },
                },
              },
            },
          ],
        },
        {
          id: 'clip_root',
          time: 1,
          type: 'live2dParameterClip',
          params: {
            target: 'tomori',
            durationSeconds: 6,
            source: {
              kind: 'inline',
              animation: {
                tracks: [{ parameterId: 'PARAM_A', keyframes: [{ time: 0, value: 0 }] }],
              },
            },
          },
        },
      ],
    });

    const result = sceneDocumentCodec.parseAndValidateWithWarnings(input);

    expect(result.migrationWarnings).toEqual([
      'Removed live2dParameterClip companion "clip_comp" under statement "dlg_1": no v4 equivalent',
      'Removed live2dParameterClip statement "clip_root" at 1s: no v4 equivalent',
    ]);
    expect(result.document.statements).toEqual([{
      id: 'dlg_1',
      time: 0,
      type: 'dialogue',
      params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
      companions: [],
    }]);
    expect(result.document.meta.durationSeconds).toBe(7);
  });

  it('throws on motion shapes the migration cannot faithfully handle', () => {
    expect(() => sceneDocumentCodec.parseAndValidateWithWarnings(makeV3Performance({ motion: 42 })))
      .toThrow(/Unsupported characterPerformance motion shape/);

    expect(() => sceneDocumentCodec.parseAndValidateWithWarnings(
      makeV3Performance({ motion: { key: 'wave', bogus: 1 } }),
    )).toThrow(/Unknown field at .*bogus/);

    expect(() => sceneDocumentCodec.parseAndValidateWithWarnings(
      makeV3Performance({ motion: 'wave', durationSeconds: 'x' }),
    )).toThrow(/Expected non-negative number at .*durationSeconds/);
  });

  it('throws on inputs violating the v3 migration contract', () => {
    expect(() => migrateSceneV3ToV4(42)).toThrow(/expects an object input/);
    expect(() => migrateSceneV3ToV4({ schemaVersion: 4 })).toThrow(/expects schemaVersion 3/);
    expect(() => migrateSceneV3ToV4({ schemaVersion: 3 })).toThrow(/expects a statements array/);
  });

  it('still rejects v2 and unversioned documents as offline-migration-only', () => {
    expect(() => sceneDocumentCodec.parseAndValidateWithWarnings({
      ...makeV3Document(),
      schemaVersion: 2,
    })).toThrow(/Unsupported scene schema version.*older scene schemas must be migrated offline/);

    expect(() => sceneDocumentCodec.parseAndValidateWithWarnings({
      sceneId: 'legacy',
      meta: { title: 'Legacy' },
      statements: [],
    })).toThrow(/Unsupported scene schema version.*older scene schemas must be migrated offline/);
  });

  it('keeps the strict v4 codec for schemaVersion 4 documents', () => {
    expect(() => sceneDocumentCodec.parseAndValidateWithWarnings({
      schemaVersion: SCENE_SCHEMA_VERSION_V4,
      sceneId: 'scene_v4_strict',
      meta: { title: 'Strict' },
      statements: [{
        id: 'perf_1',
        time: 0,
        type: 'characterPerformance',
        params: { target: 'tomori', motion: 'wave' },
      }],
    })).toThrow(/Expected object at .*motion/);
  });

  it('repairs legacy v4 implicit linear segments on companions too', () => {
    const { document, migrationWarnings } = sceneDocumentCodec.parseAndValidateWithWarnings({
      schemaVersion: SCENE_SCHEMA_VERSION_V4,
      sceneId: 'scene_v4_legacy',
      meta: { title: 'Legacy V4' },
      statements: [{
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
        companions: [{
          id: 'perf_comp',
          anchor: 'start',
          offset: 0,
          type: 'characterPerformance',
          params: {
            target: 'tomori',
            motion: {
              kind: 'custom',
              durationSeconds: 1,
              fadeInSeconds: 0,
              derivedFrom: { key: 'wave' },
              tracks: [{
                parameterId: 'PARAM_ANGLE_X',
                keyframes: [
                  { time: 0, value: 0 },
                  { time: 0.5, value: 5 },
                  { time: 1, value: 1 },
                ],
              }],
            },
          },
        }],
      }],
    });
    const motion = (document.statements[0].companions![0].params as {
      motion: { tracks: Array<{ keyframes: Array<{ segment?: unknown }> }> };
    }).motion;
    expect(motion.tracks[0].keyframes[0].segment).toEqual({ type: 'linear' });
    expect(motion.tracks[0].keyframes[1].segment).toEqual({ type: 'linear' });
    expect(motion.tracks[0].keyframes[2]).not.toHaveProperty('segment');
    expect(migrationWarnings).toEqual([
      'Completed 2 implicit linear keyframe segment(s) on custom motion "perf_comp"',
    ]);
  });

  it('repairLegacyV4CustomMotionSegments is a no-op on canonical documents', () => {
    const canonical = makeV4Document();
    const { document, warnings } = repairLegacyV4CustomMotionSegments(canonical);
    expect(document).toEqual(canonical);
    expect(warnings).toEqual([]);
  });

  it('is pure and deterministic', () => {
    const input = makeV3Document({
      statements: [
        {
          id: 'dlg_1',
          time: 0,
          type: 'dialogue',
          params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
        },
        {
          id: 'clip_root',
          time: 1,
          type: 'live2dParameterClip',
          params: { target: 'tomori', durationSeconds: 6, source: { kind: 'inline', animation: { tracks: [] } } },
        },
        {
          id: 'perf_1',
          time: 2,
          type: 'characterPerformance',
          params: { target: 'tomori', motion: 'wave', durationSeconds: 5, loop: true, priority: 5 },
        },
      ],
    });
    const snapshot = JSON.stringify(input);

    const first = JSON.stringify(migrateSceneV3ToV4(input));
    const second = JSON.stringify(migrateSceneV3ToV4(input));

    expect(first).toBe(second);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
