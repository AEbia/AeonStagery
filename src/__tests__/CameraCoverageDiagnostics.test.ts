import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CameraParams, EnvironmentLayerParams, SceneStatement } from '../api/types/semantic-scene';
import { projectToScreen } from '../engine/Projection';
import { sceneDocumentCodec, validateSemanticSceneStructure } from '../services/semantic-scene';
import { validateSemanticSceneCameraCoverageAsync } from '../services/semantic-scene/SemanticSceneValidator';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function diagnose(camera: CameraParams, backdrop: Partial<EnvironmentLayerParams> = {}, preceding: SceneStatement[] = [],
  referenceSize = { width: 1920, height: 1080 }) {
  if (camera.mode === 'move' || camera.mode === 'focus' || camera.mode === 'reset') {
    camera = { durationSeconds: 0, ...camera };
  }
  const document = sceneDocumentCodec.parseAndValidate({
    schemaVersion: 5,
    sceneId: 'camera-coverage',
    meta: { title: 'Camera coverage' },
    statements: [
      { id: 'backdrop', time: 0, type: 'environmentLayer', params: {
        mode: 'set', layerId: 'background', file: 'background/room.png', ...backdrop,
      } },
      ...preceding,
      { id: 'camera', time: 10, type: 'camera', params: camera },
    ],
  });
  return validateSemanticSceneStructure(document, { cameraReferenceSize: referenceSize, environmentImageSize: () => referenceSize })
    .filter(issue => issue.code === 'semantic.camera.black-edge' && issue.actionId === 'camera');
}

describe('camera coverage diagnostics', () => {
  it.each([false, true])('yields long coverage checks and cancels obsolete work: %s', async cancel => {
    vi.useFakeTimers();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => ++clock);
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: 5, sceneId: 'long-scene', meta: { title: 'Long scene' },
      statements: [
        { id: 'bg', time: 0, type: 'environmentLayer', params: {
          mode: 'set', layerId: 'background', file: 'room.png', transition: 'none',
        } },
        { id: 'long', time: 1, type: 'camera', params: {
          mode: 'move', to: [0.5, 0.5], durationSeconds: 60,
        } },
        { id: 'unsafe', time: 61, type: 'camera', params: {
          mode: 'move', to: [0.9, 0.5], durationSeconds: 0,
        } },
      ],
    });
    const options = { environmentImageSize: () => ({ width: 1920, height: 1080 }) };
    let current = true;
    let completed = false;
    const result = validateSemanticSceneCameraCoverageAsync(document, options, () => current)
      .then(issues => { completed = true; return issues; });
    const interaction = vi.fn(() => {
      expect(completed).toBe(false);
      if (cancel) current = false;
    });
    setTimeout(interaction, 0);
    await vi.runAllTimersAsync();
    expect(interaction).toHaveBeenCalledOnce();
    expect(await result).toEqual(cancel ? [] : validateSemanticSceneStructure(document, options)
      .filter(issue => issue.code === 'semantic.camera.black-edge'));
  });

  it('uses default transforms when replacement artwork omits them', () => {
    expect(diagnose({ mode: 'move', to: [0.75, 0.5] }, { scale: 2 }, [
      { id: 'replace', time: 2, type: 'environmentLayer', params: {
        mode: 'set', layerId: 'background', file: 'replacement.png',
      } },
    ])).toHaveLength(1);
  });

  it.each([
    { duration: 3, warnings: 0 },
    { duration: 2, warnings: 1 },
  ])('keeps interrupted anchor-dependent positions unknown until the successor completes ($duration)', ({ duration, warnings }) => {
    expect(diagnose({ mode: 'move', rotation: 45, durationSeconds: 0 }, {}, [
      { id: 'follow', time: 0, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'hero' } },
      { id: 'first', time: 7, type: 'camera', params: { mode: 'move', to: [0.5, 0.5], durationSeconds: 2 } },
      { id: 'second', time: 8, type: 'camera', params: { mode: 'move', to: [0.5, 0.5], durationSeconds: duration } },
    ])).toHaveLength(warnings);
  });

  it('attributes an instantaneous unsafe pan only to the successor', () => {
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: 5, sceneId: 'handoff', meta: { title: 'Handoff' },
      statements: [
        { id: 'bg', time: 0, type: 'environmentLayer', params: {
          mode: 'set', layerId: 'background', file: 'room.png',
        } },
        { id: 'safe', time: 1, type: 'camera', params: { mode: 'move', to: [0.5, 0.5], durationSeconds: 1 } },
        { id: 'unsafe', time: 1.5, type: 'camera', params: { mode: 'move', to: [0.75, 0.5], durationSeconds: 0 } },
      ],
    });
    expect(validateSemanticSceneStructure(document, { environmentImageSize: () => ({ width: 1920, height: 1080 }) })
      .filter(issue => issue.code === 'semantic.camera.black-edge').map(issue => issue.actionId)).toEqual(['unsafe']);
  });

  it.each([
    { name: 'rotated backdrop corners', layerRotation: 45, rotation: 0, scale: 1, zoom: 1, x: 0.5, y: 0.5 },
    { name: 'matching rotations', layerRotation: 30, rotation: 30, scale: 1, zoom: 1, x: 0.5, y: 0.5 },
    { name: 'landscape rotation', layerRotation: 0, rotation: 30, scale: 1, zoom: 1.5, x: 0.5, y: 0.5 },
    { name: 'portrait rotation', layerRotation: 0, rotation: 30, scale: 1, zoom: 1.5, x: 0.5, y: 0.5, portrait: true },
    { name: 'rotated translation', layerRotation: 45, rotation: 45, scale: 1.4, zoom: 1, x: 0.65, y: 0.65 },
    { name: 'covered rotated translation', layerRotation: 45, rotation: 45, scale: 2, zoom: 1, x: 0.6, y: 0.55 },
    { name: 'covered camera rotation', layerRotation: 0, rotation: 30, scale: 1, zoom: 2, x: 0.5, y: 0.5 },
  ])('matches projected corner containment: $name', ({ layerRotation, rotation, scale, zoom, x, y, portrait }) => {
    const size = portrait ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
    const projected = projectToScreen(
      { x: size.width / 2, y: size.height / 2, scale, rotation: layerRotation },
      { position: [x, y], zoom, rotation },
      { w: size.width, h: size.height },
    );
    // Invert the rendered sprite transform at each output corner. An AABB
    // containing the frame is insufficient when the sprite itself is rotated.
    const angle = -projected.screenRotation * Math.PI / 180;
    const exposed = [[0, 0], [size.width, 0], [0, size.height], [size.width, size.height]].some(([cx, cy]) => {
      const dx = (cx - projected.screenX) / projected.screenScale;
      const dy = (cy - projected.screenY) / projected.screenScale;
      const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
      const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
      return Math.abs(localX) > size.width / 2 + 1e-6 || Math.abs(localY) > size.height / 2 + 1e-6;
    });
    expect(diagnose({ mode: 'move', to: [x, y], rotation, zoom: { kind: 'absolute', value: zoom } },
      { rotation: layerRotation, scale }, [], size).length > 0).toBe(exposed);
  });

  it('checks zoom-only moves at the held camera position', () => {
    expect(diagnose({ mode: 'move', zoom: { kind: 'absolute', value: 1 } }, {}, [
      { id: 'pan', time: 1, type: 'camera', params: {
        mode: 'move', to: [0.7, 0.5], zoom: { kind: 'absolute', value: 2 },
      } },
    ])).toHaveLength(1);
  });

  it('checks rotation-only moves at the default position', () => {
    expect(diagnose({ mode: 'move', rotation: 30 })).toHaveLength(1);
  });

  it('checks path frames which only change zoom and reports one warning per statement', () => {
    expect(diagnose({ mode: 'path', keyframes: [
      { time: 0, position: [0.7, 0.5], zoom: 2 },
      { time: 1, zoom: 1 },
      { time: 2, zoom: 0.8 },
    ] })).toHaveLength(1);
  });

  it('does not reset zoom or rotation when a follow stops', () => {
    expect(diagnose({ mode: 'move', to: [0.7, 0.5] }, {}, [
      { id: 'zoom', time: 1, type: 'camera', params: { mode: 'move', zoom: { kind: 'absolute', value: 2 } } },
      { id: 'follow', time: 2, type: 'camera', params: { mode: 'follow', operation: 'start', target: 'hero' } },
      { id: 'stop', time: 3, type: 'camera', params: { mode: 'follow', operation: 'stop' } },
    ])).toHaveLength(0);
  });

  it.each([-200, 0, 200])('combines two partial layers regardless of draw order %s', z => {
    expect(diagnose({ mode: 'move', to: [0.75, 0.5] }, {}, [
      { id: 'second', time: 1, type: 'environmentLayer', params: {
        mode: 'set', layerId: 'second', file: 'second.png', position: [1, 0.5], z,
      } },
    ])).toHaveLength(0);
  });

  it('finds a gap between layers even when their union contains all four frame corners', () => {
    expect(diagnose({ mode: 'move', to: [0.75, 0.5] }, { position: [0.4, 0.5] }, [
      { id: 'second', time: 1, type: 'environmentLayer', params: {
        mode: 'set', layerId: 'second', file: 'second.png', position: [1.5, 0.5],
      } },
    ])).toHaveLength(1);
  });

  it('does not count invisible layers as coverage', () => {
    expect(diagnose({ mode: 'move', to: [0.75, 0.5] }, {}, [
      { id: 'second', time: 1, type: 'environmentLayer', params: {
        mode: 'set', layerId: 'second', file: 'second.png', position: [1, 0.5], opacity: 0,
      } },
    ])).toHaveLength(1);
  });

  it('detects exposure during a rotation whose start and end frames are both covered', () => {
    expect(diagnose({ mode: 'move', rotation: 180, durationSeconds: 1 })).toHaveLength(1);
  });

  it('reports an entirely invisible environment as uncovered', () => {
    expect(diagnose({ mode: 'move', to: [0.5, 0.5] }, { opacity: 0 })).toHaveLength(1);
  });

  it('uses the current transform of every layer while the camera moves', () => {
    expect(diagnose({ mode: 'move', to: [0.75, 0.5], durationSeconds: 1 }, {}, [
      { id: 'second', time: 1, type: 'environmentLayer', params: {
        mode: 'set', layerId: 'second', file: 'second.png', position: [1, 0.5],
      } },
      { id: 'slide-away', time: 10.2, type: 'environmentLayer', params: {
        mode: 'transform', layerId: 'second', position: [2, 0.5], durationSeconds: 0.5,
      } },
    ])).toHaveLength(1);
  });

  it('continues checking a position path after another action takes over only zoom', () => {
    expect(diagnose({ mode: 'path', keyframes: [
      { time: 0, position: [0.5, 0.5], zoom: 2 },
      { time: 4, position: [0.9, 0.5] },
    ] }, {}, [
      { id: 'zoom-only', time: 11, type: 'camera', params: {
        mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0.2,
      } },
    ])).toHaveLength(1);
  });

  it('checks later loop cycles against environment changes at those times', () => {
    expect(diagnose({ mode: 'path', loop: true, keyframes: [
      { time: 0, position: [0.5, 0.5], zoom: 2 },
      { time: 1, position: [0.6, 0.5] },
    ] }, {}, [
      { id: 'hide', time: 12, type: 'environmentLayer', params: {
        mode: 'transform', layerId: 'background', opacity: 0, durationSeconds: 0.1,
      } },
    ])).toHaveLength(1);
  });

  it.each([
    { repeat: 1, yoyo: false, exposedAt: '11.01' },
    { repeat: 1, yoyo: true, exposedAt: '11.99' },
    { loop: true, yoyo: false, exposedAt: '11.01' },
    { loop: true, yoyo: true, exposedAt: '11.99' },
    { repeat: -1, yoyo: false, exposedAt: '11.01' },
    { repeat: -1, yoyo: true, exposedAt: '11.99' },
  ])('checks repeated keyframes between output frames: %j', async ({ exposedAt, ...repetition }) => {
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: 5, sceneId: 'repeated-keyframes', meta: { title: 'Repeated keyframes', durationSeconds: 12 },
      statements: [
        { id: 'bg', time: 0, type: 'environmentLayer', params: {
          mode: 'set', layerId: 'background', file: 'room.png', scale: 2, transition: 'none', durationSeconds: 0,
        } },
        { id: 'camera', time: 10, type: 'camera', params: {
          mode: 'path', ...repetition, keyframes: [
            { time: 0, position: [0.5, 0.5] },
            { time: 0.007, position: [0.5, 0.5], ease: 'linear' },
            { time: 0.008, position: [0.6, 0.5], ease: 'linear' },
            { time: 0.009, position: [0.5, 0.5], ease: 'linear' },
            { time: 1, position: [0.5, 0.5], ease: 'linear' },
          ],
        } },
        { id: 'shrink', time: 11, type: 'environmentLayer', params: {
          mode: 'transform', layerId: 'background', scale: 1, durationSeconds: 0,
        } },
      ],
    });
    const options = { cameraSampleFps: 60, environmentImageSize: () => ({ width: 1920, height: 1080 }) };
    const coverage = (scene: typeof document) => validateSemanticSceneStructure(scene, options)
      .filter(issue => issue.code === 'semantic.camera.black-edge');
    // The first cycle is covered. In the next cycle only the narrow peak
    // exposes edges, and both adjacent output frames remain covered.
    expect(coverage({ ...document, statements: document.statements.filter(statement => statement.id !== 'shrink') }))
      .toEqual([]);
    const issues = coverage(document);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ actionId: 'camera', message: expect.stringContaining(`${exposedAt} 秒`) });
    expect(await validateSemanticSceneCameraCoverageAsync(document, options, () => true)).toEqual(issues);
  });

  it.each([
    { yoyo: false, handoff: 11.008, warnings: 0 },
    { yoyo: false, handoff: 11.009, warnings: 1 },
    { yoyo: true, handoff: 11.992, warnings: 0 },
    { yoyo: true, handoff: 11.993, warnings: 1 },
  ])('samples repeated keyframes only before position handoff: %j', ({ yoyo, handoff, warnings }) => {
    expect(diagnose({ mode: 'path', repeat: 1, yoyo, keyframes: [
      { time: 0, position: [0.5, 0.5] },
      { time: 0.007, position: [0.5, 0.5], ease: 'linear' },
      { time: 0.008, position: [0.6, 0.5], ease: 'linear' },
      { time: 0.009, position: [0.5, 0.5], ease: 'linear' },
      { time: 1, position: [0.5, 0.5], ease: 'linear' },
    ] }, { scale: 2 }, [
      { id: 'shrink', time: 11, type: 'environmentLayer', params: {
        mode: 'transform', layerId: 'background', scale: 1, durationSeconds: 0,
      } },
      { id: 'successor', time: handoff, type: 'camera', params: {
        mode: 'move', to: [0.5, 0.5], durationSeconds: 0,
      } },
    ])).toHaveLength(warnings);
  });

  it.each([{ loop: true }, { repeat: -1 }])('checks later output frames through the derived scene end: %j', async repetition => {
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: 5, sceneId: 'loop-duration', meta: { title: 'Loop duration' },
      statements: [
        { id: 'bg', time: 0, type: 'environmentLayer', params: {
          mode: 'set', layerId: 'background', file: 'room.png', scale: 1.5, transition: 'none', durationSeconds: 0,
        } },
        { id: 'camera', time: 0, type: 'camera', params: {
          mode: 'path', durationSeconds: 10, ...repetition, keyframes: [
            { time: 0, rotation: 0 },
            { time: 1 / 59, rotation: 180, ease: 'linear' },
          ],
        } },
      ],
    });
    const options = { cameraSampleFps: 60, environmentImageSize: () => ({ width: 1920, height: 1080 }) };
    // The first cycle's output frames are covered; later cycles sample
    // different rotation phases and expose edges within the scene's duration.
    const explicitIssues = validateSemanticSceneStructure({
      ...document, meta: { ...document.meta, durationSeconds: 10 },
    }, options).filter(issue => issue.code === 'semantic.camera.black-edge');
    expect(explicitIssues).toHaveLength(1);
    expect(validateSemanticSceneStructure(document, options)
      .filter(issue => issue.code === 'semantic.camera.black-edge')).toEqual(explicitIssues);
    expect(await validateSemanticSceneCameraCoverageAsync(document, options, () => true)).toEqual(explicitIssues);
  });

  it.each([
    { time: 9.5, exposed: false },
    { time: 7.5, exposed: true },
  ])('retains outgoing image geometry during cross-fades starting at $time', ({ time, exposed }) => {
    expect(diagnose({ mode: 'move', to: [0.75, 0.5] }, { scale: 2 }, [
      { id: 'replace', time, type: 'environmentLayer', params: {
        mode: 'set', layerId: 'background', file: 'replacement.png', scale: 0.5,
        transition: 'crossFade', durationSeconds: 2,
      } },
    ]).length > 0).toBe(exposed);
  });

  it.each([
    { time: 9.5, exposed: false },
    { time: 7.5, exposed: true },
  ])('counts a fading layer only until removal completes at $time + 2', ({ time, exposed }) => {
    expect(diagnose({ mode: 'move', to: [0.75, 0.5] }, {}, [
      { id: 'second', time: 1, type: 'environmentLayer', params: {
        mode: 'set', layerId: 'second', file: 'second.png', position: [1, 0.5],
      } },
      { id: 'remove', time, type: 'environmentLayer', params: {
        mode: 'remove', layerId: 'second', transition: 'fadeOut', durationSeconds: 2,
      } },
    ]).length > 0).toBe(exposed);
  });

  it('defers warnings when actual artwork dimensions are unavailable', () => {
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: 5, sceneId: 'unknown-dimensions', meta: { title: 'Unknown dimensions' },
      statements: [
        { id: 'bg', time: 0, type: 'environmentLayer', params: {
          mode: 'set', layerId: 'background', file: 'unknown.png',
        } },
        { id: 'camera', time: 1, type: 'camera', params: { mode: 'move', to: [0.9, 0.5] } },
      ],
    });
    expect(validateSemanticSceneStructure(document, { environmentImageSize: () => undefined })
      .filter(issue => issue.code === 'semantic.camera.black-edge')).toEqual([]);
  });
});
