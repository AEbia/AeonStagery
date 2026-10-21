import { describe, expect, it } from 'vitest';
import { sceneDocumentCodec, sceneStatementDefinitionRegistry, validateSemanticSceneStructure } from '../services/semantic-scene';
import { sceneStatementCompiler } from '../services/semantic-scene/SceneStatementCompiler';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';

function makeDocument(statements: unknown[]): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: 4,
    sceneId: 'camera-compilation-contract',
    meta: { title: 'Camera compilation contract', characters: [{ id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' }] },
    statements,
  });
}

describe('semantic camera compilation contracts', () => {
  it('keeps follow active through independent zoom and rotation writes', () => {
    const document = makeDocument([
      { id: 'follow', time: 1, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'tomori' } },
      { id: 'zoom', time: 2, type: 'camera', params: { mode: 'move', zoom: { kind: 'absolute', value: 1.2 }, rotation: 0.1 } },
      { id: 'second-follow', time: 3, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'tomori' } },
    ]);
    expect(validateSemanticSceneStructure(document).some((issue) => issue.code === 'semantic.camera.follow.overlap')).toBe(true);
    expect(() => sceneStatementCompiler.compile(document)).toThrow('still active');
  });

  it('uses key times for path motion and extends finite repeat occupancy', () => {
    const path = {
      mode: 'path',
      keyframes: [{ time: 0, position: [0.2, 0.3] }, { time: 2, zoom: 1.4 }],
      durationSeconds: 1,
      repeat: 2,
      yoyo: true,
    };
    const document = makeDocument([
      { id: 'path', time: 1, type: 'camera', params: path },
    ]);
    expect(sceneStatementDefinitionRegistry.temporalExtent(document.statements[0])).toBe(6);
    const compiled = sceneStatementCompiler.compile(document);
    expect(compiled.durationSeconds).toBe(7);
  });

  it('keeps sparse path channels independent when deciding follow release', () => {
    const positionPath = makeDocument([
      { id: 'follow', time: 0, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'tomori' } },
      { id: 'sparse-position-path', time: 1, type: 'camera', params: {
        mode: 'path', keyframes: [{ time: 0, zoom: 1.1 }, { time: 1, position: [0.3, 0.4] }],
      } },
      { id: 'follow-again', time: 2, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'tomori' } },
    ]);
    expect(sceneStatementCompiler.compile(positionPath).actions.map((action) => action.action))
      .toEqual(['cameraFollow', 'cameraPath', 'cameraFollow']);

    const zoomPath = makeDocument([
      { id: 'follow', time: 0, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'tomori' } },
      { id: 'sparse-zoom-path', time: 1, type: 'camera', params: {
        mode: 'path', keyframes: [{ time: 0, zoom: 1 }, { time: 1, zoom: 1.1 }],
      } },
      { id: 'follow-again', time: 2, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'tomori' } },
    ]);
    expect(() => sceneStatementCompiler.compile(zoomPath)).toThrow('still active');
  });

  it('gives loop and infinite repeat priority without making scene duration infinite', () => {
    const path = (repeat?: number, loop?: boolean, durationSeconds?: number) => ({
      mode: 'path', keyframes: [{ time: 0 }, { time: 2, zoom: 1.2 }], repeat, loop, durationSeconds,
    });
    for (const params of [path(3, true), path(-1, false)]) {
      const document = makeDocument([{ id: 'path', time: 1, type: 'camera', params }]);
      expect(sceneStatementDefinitionRegistry.temporalExtent(document.statements[0])).toBe(2);
      expect(sceneStatementCompiler.compile(document).durationSeconds).toBe(3);
    }
    const extended = makeDocument([{ id: 'path', time: 1, type: 'camera', params: path(-1, true, 5) }]);
    expect(sceneStatementCompiler.compile(extended).durationSeconds).toBe(6);
  });

  it('rejects invalid repeat counts and retired Hitchcock source', () => {
    for (const repeat of [-2, 1.5]) {
      expect(() => makeDocument([{ id: 'path', time: 0, type: 'camera', params: {
        mode: 'path', keyframes: [{ time: 0 }, { time: 1, zoom: 1.2 }], repeat,
      } }])).toThrow('integer greater than or equal to -1');
    }
    expect(() => makeDocument([{ id: 'hitchcock', time: 0, type: 'camera', params: { mode: 'hitchcock' } }]))
      .toThrow('Camera mode "hitchcock" has been retired at scene.statements[0].params. Use focus, move, or path instead.');
  });
});
