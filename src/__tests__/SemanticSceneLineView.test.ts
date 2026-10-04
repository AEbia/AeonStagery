import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  SemanticSceneLineView,
  buildSemanticSceneLineView,
} from '../services/semantic-scene/SemanticSceneLineView';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_line_view',
    meta: {
      title: 'Line View',
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [
      {
        id: 'stmt_camera',
        time: 0,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 0.2 },
      },
      {
        id: 'stmt_dialogue',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Hello',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'cmp_focus',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '$speaker',
              durationSeconds: 0.25,
            },
          },
          {
            id: 'cmp_perf',
            anchor: 'start',
            offset: 0.1,
            type: 'characterPerformance',
            params: {
              target: 'tomori',
              motion: { kind: 'resource', key: 'idle' },
            },
          },
        ],
      },
      {
        id: 'stmt_presence',
        time: 1,
        type: 'characterPresence',
        params: {
          mode: 'enter',
          id: 'tomori',
          model: 'figure/tomori/model.json',
        },
      },
    ],
  };
}

function makeCustomMotionDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_custom_motion',
    meta: {
      title: 'Custom Motion',
      characters: [{ id: 'tomori', name: 'Tomori' }],
    },
    statements: [
      {
        id: 'stmt_dialogue',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'Hello',
          durationSeconds: 4,
        },
        companions: [
          {
            id: 'cmp_perf',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: 'tomori',
              motion: {
                kind: 'custom',
                durationSeconds: 3.4,
                fadeInSeconds: 0.5,
                derivedFrom: { key: '点头_02.mtn', fadeInSeconds: 0.35, fadeOutSeconds: 0.3 },
                tracks: [
                  {
                    parameterId: 'ParamAngleX',
                    fadeInSeconds: 0.4,
                    keyframes: [
                      { time: 0, value: 0, segment: { type: 'linear' } },
                      { time: 1, value: 12, segment: { type: 'linear' } },
                      { time: 2, value: 0, segment: { type: 'linear' } },
                    ],
                  },
                  {
                    parameterId: 'ParamAngleY',
                    keyframes: [
                      { time: 0, value: 0 },
                      {
                        time: 1.5,
                        value: -8,
                        segment: {
                          type: 'bezier',
                          controlPoints: [
                            { time: 0.5, value: -4 },
                            { time: 1, value: -6 },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  };
}

describe('SemanticSceneLineView', () => {
  it('flattens roots and companions in source order without time sorting', () => {
    const view = buildSemanticSceneLineView(makeDocument());
    expect(view.totalLines).toBe(5);
    expect(view.lines.map((line) => ({ line: line.line, kind: line.kind, type: line.type, parentLine: line.parentLine }))).toEqual([
      { line: 1, kind: 'statement', type: 'camera', parentLine: undefined },
      { line: 2, kind: 'statement', type: 'dialogue', parentLine: undefined },
      { line: 3, kind: 'companion', type: 'camera', parentLine: 2 },
      { line: 4, kind: 'companion', type: 'characterPerformance', parentLine: 2 },
      { line: 5, kind: 'statement', type: 'characterPresence', parentLine: undefined },
    ]);
  });

  it('hides host UUIDs while keeping domain params.id visible', () => {
    const view = buildSemanticSceneLineView(makeDocument());
    const json = JSON.stringify(view);
    expect(json).not.toContain('stmt_dialogue');
    expect(json).not.toContain('cmp_focus');
    expect(json).not.toContain('scene_line_view');
    const presence = view.lines.find((line) => line.type === 'characterPresence')!;
    expect(presence.params.id).toBe('tomori');
  });

  it('resolves internal locators for the host without exposing them in toJSON', () => {
    const host = new SemanticSceneLineView(makeDocument());
    expect(host.resolveInternal(3)).toMatchObject({
      line: 3,
      kind: 'companion',
      statementId: 'stmt_dialogue',
      companionId: 'cmp_focus',
    });
    expect(JSON.stringify(host.toJSON())).not.toContain('stmt_dialogue');
  });

  it('compacts custom-motion track keyframes to keyframeCount metadata in the model-facing view', () => {
    const view = buildSemanticSceneLineView(makeCustomMotionDocument());
    const json = JSON.stringify(view);
    expect(json).not.toContain('keyframes');
    expect(json).not.toContain('segment');
    expect(json).not.toContain('controlPoints');
    const perf = view.lines.find((line) => line.type === 'characterPerformance')!;
    const motion = (perf.params as { motion: Record<string, unknown> }).motion;
    expect(motion).toMatchObject({
      kind: 'custom',
      durationSeconds: 3.4,
      fadeInSeconds: 0.5,
      derivedFrom: { key: '点头_02.mtn' },
      tracks: [
        { parameterId: 'ParamAngleX', fadeInSeconds: 0.4, keyframeCount: 3 },
        { parameterId: 'ParamAngleY', keyframeCount: 2 },
      ],
    });
  });

  it('keeps resource motions untouched in the model-facing view', () => {
    const view = buildSemanticSceneLineView(makeDocument());
    const perf = view.lines.find((line) => line.type === 'characterPerformance')!;
    expect(perf.params.motion).toEqual({ kind: 'resource', key: 'idle' });
  });
});
