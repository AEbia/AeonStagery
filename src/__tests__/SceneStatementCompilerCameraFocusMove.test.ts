import { describe, expect, it } from 'vitest';
import { sceneDocumentCodec } from '../services/semantic-scene';
import { sceneStatementCompiler } from '../services/semantic-scene/SceneStatementCompiler';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import { MOVE_HANDLERS } from '../engine/MoveHandlers';

function makeDocument(statements: unknown[]): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: 4,
    sceneId: 'camera-focus-move',
    meta: {
      title: 'Camera focus move contract',
      characters: [{ id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' }],
    },
    statements,
  });
}

function compileFocusMove(params: Record<string, unknown>): Record<string, any> {
  const compiled = sceneStatementCompiler.compile(makeDocument([
    {
      id: 'focus_statement',
      time: 1,
      type: 'camera',
      params,
    },
  ]));
  return compiled.actions[0] as Record<string, any>;
}

/**
 * Contract: every `move` the compiler emits for camera statements must be a
 * registered MOVE_HANDLERS key. `executeMotion()` throws
 * "[Camera] Unknown move type" otherwise, breaking playback/export for the
 * whole scene at schedule time.
 */
describe('scene statement compiler — camera focus lowered move types', () => {
  const cases: Array<{
    name: string;
    params: Record<string, unknown>;
    expectedMove: string;
  }> = [
    {
      name: 'focus with target and no zoom lowers to a position-only move',
      params: { mode: 'focus', target: 'tomori', targetPart: 'head', durationSeconds: 1 },
      expectedMove: 'pan',
    },
    {
      name: 'focus with absolute zoom lowers to zoom',
      params: { mode: 'focus', target: 'tomori', zoom: { kind: 'absolute', value: 1.2 }, durationSeconds: 1 },
      expectedMove: 'zoom',
    },
    {
      name: 'focus with positive delta zoom lowers to push',
      params: { mode: 'focus', target: 'tomori', zoom: { kind: 'delta', value: 0.3 }, durationSeconds: 1 },
      expectedMove: 'push',
    },
    {
      name: 'focus with negative delta zoom lowers to pull',
      params: { mode: 'focus', target: 'tomori', zoom: { kind: 'delta', value: -0.3 }, durationSeconds: 1 },
      expectedMove: 'pull',
    },
    {
      name: 'focus without target keeps the pan fallback',
      params: { mode: 'focus', position: [0.4, 0.6], durationSeconds: 1 },
      expectedMove: 'pan',
    },
  ];

  for (const { name, params, expectedMove } of cases) {
    it(`${name} and the emitted move exists in MOVE_HANDLERS`, () => {
      const action = compileFocusMove(params);

      expect(action.action).toBe('cameraMotion');
      expect(MOVE_HANDLERS).toHaveProperty(action.params.move);
      expect(action.params.move).toBe(expectedMove);
    });
  }

  it('keeps the focus subject metadata through the pan lowering', () => {
    const action = compileFocusMove({ mode: 'focus', target: 'tomori', targetPart: 'head', durationSeconds: 1 });

    expect(action.params.focus).toEqual({ character: 'tomori', part: 'head' });
  });
});
