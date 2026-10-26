import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import { SemanticScenePipeline } from '../../services/semantic-scene/SemanticScenePipeline';

/** One authored camera arrangement shared by playback, seek, Bake and capture. */
export async function cameraCrossEntryScene(historical = false) {
  const statements: CurrentSceneDocument['statements'] = [
    { id: 'move', type: 'camera', time: 0.5, params: { mode: 'move', position: [0.7, 0.3], zoom: { kind: 'absolute', value: 2 }, rotation: 30, durationSeconds: 1, ease: 'linear' } },
    { id: 'shake-a', type: 'camera', time: 0.75, params: { mode: 'shake', intensity: 0.4, frequency: 7, durationSeconds: 1.5 } },
    { id: 'shake-b', type: 'camera', time: 1, params: { mode: 'shake', intensity: 0.2, frequency: 11, durationSeconds: 1 } },
    { id: 'reset', type: 'camera', time: 2, params: { mode: 'reset', durationSeconds: 0 } },
    { id: 'sparse-loop', type: 'camera', time: 2.5, params: { mode: 'path', ease: 'linear', loop: true, keyframes: [{ time: 0.25, zoom: 1.5 }, { time: 1, zoom: 2, rotation: 45 }] } },
  ];
  if (historical) {
    statements.splice(3, 2,
      { id: 'focus', type: 'camera', time: 1.5, params: { mode: 'focus', target: 'hero', targetPart: 'head', durationSeconds: 0.25, ease: 'linear' } },
      { id: 'follow', type: 'camera', time: 1.75, params: { mode: 'follow', operation: 'start', target: 'hero', smoothing: 0.5 } },
      { id: 'takeover', type: 'camera', time: 3.25, params: { mode: 'move', position: [0.3, 0.6], durationSeconds: 0.5, ease: 'linear' } },
      { id: 'reset', type: 'camera', time: 4, params: { mode: 'reset', durationSeconds: 0 } },
      { id: 'shake-after-reset', type: 'camera', time: 4, params: { mode: 'shake', intensity: 0.2, frequency: 9, durationSeconds: 0.5 } },
      { id: 'sparse-loop', type: 'camera', time: 4.5, params: { mode: 'path', ease: 'linear', loop: true, keyframes: [{ time: 0.25, zoom: 1.5 }, { time: 1, zoom: 2, rotation: 45 }] } },
      { id: 'enter', type: 'characterPresence', time: 0.25, params: { mode: 'enter', id: 'hero', position: [0.65, 0.45], durationSeconds: 0 } },
      { id: 'walk', type: 'characterTransform', time: 0.5, params: { id: 'hero', position: [0.75, 0.35], durationSeconds: 1, ease: 'linear' } },
      { id: 'leave', type: 'characterPresence', time: 2.25, params: { mode: 'exit', id: 'hero', durationSeconds: 0 } },
      { id: 'return', type: 'characterPresence', time: 2.75, params: { mode: 'enter', id: 'hero', position: [0.3, 0.6], durationSeconds: 0 } },
    );
  }
  return (await new SemanticScenePipeline({ resolveAsset: source => source }).processDocument({
    schemaVersion: 5, sceneId: 'camera-cross-entry',
    meta: { title: 'Camera cross-entry', resolution: [1920, 1080], fps: 60, durationSeconds: historical ? 7 : 5,
      ...(historical ? { characters: [{ id: 'hero', name: 'Hero', model: 'hero.model3.json' }] } : {}),
    }, statements,
  })).prepared;
}
