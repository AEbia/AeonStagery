import { describe, expect, it, vi } from 'vitest';
import { ValidationDaemon } from '../engine/daemons/ValidationDaemon';
import { DocumentStore } from '../ui/store/DocumentStore';
import { ValidationStore } from '../ui/store/ValidationStore';
import {
  sceneDocumentCodec,
  validateSemanticSceneStructure,
} from '../services/semantic-scene';
import {
  SEMANTIC_VISUAL_DIAGNOSTIC_CODES,
} from '../services/semantic-scene/SemanticSceneValidator';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import type { ProjectResourceService } from '../services/io/ProjectResourceService';
import type { ResourceResolution } from '../api/types/project';

function makeDocument(statements: unknown[]): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: 4,
    sceneId: 'semantic-visual-diagnostics',
    meta: {
      title: 'Semantic visual diagnostics',
      characters: [{ id: 'hero', name: 'Hero', model: 'figure/hero/model.json' }],
    },
    statements,
  });
}

function issueFor(
  issues: ReturnType<typeof validateSemanticSceneStructure>,
  code: string,
  actionId: string,
) {
  return issues.find((issue) => issue.code === code && issue.actionId === actionId);
}

describe('semantic visual diagnostics', () => {
  it('reports sparse camera and lighting operations with stable identity and locations', () => {
    const document = makeDocument([
      {
        id: 'camera-move-empty',
        time: 0,
        type: 'camera',
        params: { mode: 'move' },
      },
      {
        id: 'camera-focus-empty',
        time: 1,
        type: 'camera',
        params: { mode: 'focus', target: '' },
      },
      {
        id: 'camera-focus-unknown',
        time: 2,
        type: 'camera',
        params: { mode: 'focus', target: 'missing-character' },
      },
      {
        id: 'camera-path-empty',
        time: 3,
        type: 'camera',
        params: {
          mode: 'path',
          keyframes: [{ time: 0 }, { time: 1 }],
        },
      },
      {
        id: 'camera-follow-empty',
        time: 4,
        type: 'camera',
        params: { mode: 'follow', operation: 'start', target: '' },
      },
      {
        id: 'camera-follow-start',
        time: 5,
        type: 'camera',
        params: { mode: 'follow', operation: 'start', target: 'hero' },
      },
      {
        id: 'camera-follow-stop-empty',
        time: 6,
        type: 'camera',
        params: { mode: 'follow', operation: 'stop', target: '' },
      },
      {
        id: 'camera-follow-stop-missing',
        time: 7,
        type: 'camera',
        params: { mode: 'follow', operation: 'stop' },
      },
      {
        id: 'lighting-reset-missing',
        time: 8,
        type: 'lighting',
        params: { effect: 'godrays', mode: 'reset' },
      },
      {
        id: 'lighting-godrays-empty',
        time: 9,
        type: 'lighting',
        params: { effect: 'godrays', mode: 'set' },
      },
      {
        id: 'lighting-overlay-missing-id',
        time: 10,
        type: 'lighting',
        params: { effect: 'overlay', mode: 'remove' },
      },
      {
        id: 'lighting-overlay-absent',
        time: 11,
        type: 'lighting',
        params: { effect: 'overlay', mode: 'remove', id: 'not-active' },
      },
      {
        id: 'lighting-point-empty-id',
        time: 12,
        type: 'lighting',
        params: { effect: 'pointLight', mode: 'set', id: '' },
      },
      {
        id: 'lighting-point-absent',
        time: 13,
        type: 'lighting',
        params: { effect: 'pointLight', mode: 'remove', id: 'not-active' },
      },
      {
        id: 'lighting-blur-empty-target',
        time: 14,
        type: 'lighting',
        params: { effect: 'blur', mode: 'reset', target: '' },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraMoveMissingOperation, 'camera-move-empty'))
      .toMatchObject({
        severity: 'error',
        actionType: 'camera',
        location: 'scene.statements["camera-move-empty"].params',
        message: expect.stringContaining('position'),
      });
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraTargetEmpty, 'camera-focus-empty'))
      .toMatchObject({ location: 'scene.statements["camera-focus-empty"].params.target' });
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraTargetUnknown, 'camera-focus-unknown'))
      .toMatchObject({ message: expect.stringContaining('missing-character') });
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraPathMissingValues, 'camera-path-empty'))
      .toMatchObject({ location: 'scene.statements["camera-path-empty"].params.keyframes' });
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraFollowMissingTarget, 'camera-follow-empty'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraTargetEmpty, 'camera-follow-stop-empty'))
      .toMatchObject({ location: 'scene.statements["camera-follow-stop-empty"].params.target' });
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraFollowStopWithoutActiveTarget, 'camera-follow-stop-missing'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingResetWithoutActiveResource, 'lighting-reset-missing'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingGodraysMissingValues, 'lighting-godrays-empty'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingOverlayMissingId, 'lighting-overlay-missing-id'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingOverlayMissingResource, 'lighting-overlay-absent'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPointLightMissingId, 'lighting-point-empty-id'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPointLightMissingResource, 'lighting-point-absent'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingBlurTargetEmpty, 'lighting-blur-empty-target'))
      .toBeDefined();
  });

  it('keeps valid sparse camera companions and lifecycle resources clean', () => {
    const document = makeDocument([
      {
        id: 'dialogue-with-focus',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'hero', text: 'Hello', durationSeconds: 1 },
        companions: [{
          id: 'focus-speaker',
          anchor: 'start',
          offset: 0,
          type: 'camera',
          params: { mode: 'focus', target: '$speaker' },
        }],
      },
      {
        id: 'camera-zoom-only',
        time: 1,
        type: 'camera',
        params: { mode: 'move', zoom: { kind: 'delta', value: 0.2 } },
      },
      {
        id: 'camera-follow-start',
        time: 2,
        type: 'camera',
        params: { mode: 'follow', operation: 'start', target: 'hero' },
      },
      {
        id: 'camera-follow-stop',
        time: 3,
        type: 'camera',
        params: { mode: 'follow', operation: 'stop' },
      },
      {
        id: 'camera-path-zoom',
        time: 4,
        type: 'camera',
        params: {
          mode: 'path',
          keyframes: [{ time: 0 }, { time: 1, zoom: 1.2 }],
        },
      },
      {
        id: 'lighting-godrays-set',
        time: 5,
        type: 'lighting',
        params: { effect: 'godrays', mode: 'set', intensity: 0.4 },
      },
      {
        id: 'lighting-godrays-reset',
        time: 6,
        type: 'lighting',
        params: { effect: 'godrays', mode: 'reset' },
      },
      {
        id: 'lighting-overlay-set',
        time: 7,
        type: 'lighting',
        params: { effect: 'overlay', mode: 'set', id: 'overlay-main' },
      },
      {
        id: 'lighting-overlay-remove',
        time: 8,
        type: 'lighting',
        params: { effect: 'overlay', mode: 'remove', id: 'overlay-main' },
      },
      {
        id: 'lighting-point-set',
        time: 9,
        type: 'lighting',
        params: { effect: 'pointLight', mode: 'set', id: 'point-main' },
      },
      {
        id: 'lighting-point-remove',
        time: 10,
        type: 'lighting',
        params: { effect: 'pointLight', mode: 'remove', id: 'point-main' },
      },
    ]);

    expect(validateSemanticSceneStructure(document)).toEqual([]);
  });

  it('validates post targets against declared objects without requiring active-time presence', () => {
    const document = makeDocument([
      {
        id: 'post-before-layer',
        time: 0,
        type: 'lighting',
        params: { effect: 'post', mode: 'set', target: 'later-layer', adjGamma: 1.1 },
      },
      {
        id: 'post-character',
        time: 1,
        type: 'lighting',
        params: { effect: 'post', mode: 'set', target: 'hero', adjContrast: 1.2 },
      },
      {
        id: 'post-panorama',
        time: 2,
        type: 'lighting',
        params: { effect: 'post', mode: 'set', target: 'panorama', adjSaturation: 1.1 },
      },
      {
        id: 'layer-declaration-after-post',
        time: 3,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'later-layer', image: 'background/room.png' },
      },
      {
        id: 'post-empty-target',
        time: 4,
        type: 'lighting',
        params: { effect: 'post', mode: 'modulate', target: '', adjGamma: 1 },
      },
      {
        id: 'post-unknown-target',
        time: 5,
        type: 'lighting',
        params: { effect: 'post', mode: 'modulate', target: 'missing-object', adjGamma: 1 },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPostTargetEmpty, 'post-empty-target'))
      .toMatchObject({ location: 'scene.statements["post-empty-target"].params.target' });
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPostTargetUnknown, 'post-unknown-target'))
      .toMatchObject({ message: expect.stringContaining('missing-object') });
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingPostTargetUnknown, 'post-before-layer'))
      .toBeUndefined();
  });

  it('reports black-edge risk when camera panning exceeds background coverage', () => {
    const document = makeDocument([
      {
        id: 'bg-set',
        time: 0,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'background', image: 'background/room.png' },
      },
      {
        id: 'move-pan-unsafe',
        time: 1,
        type: 'camera',
        params: { mode: 'move', to: [0.75, 0.5] },
      },
      {
        id: 'move-pan-zoom-safe',
        time: 2,
        type: 'camera',
        params: { mode: 'move', to: [0.64, 0.5], zoom: { kind: 'absolute', value: 1.4 } },
      },
      {
        id: 'focus-point-unsafe',
        time: 3,
        type: 'camera',
        params: { mode: 'focus', position: [0.5, 0.2] },
      },
      {
        id: 'path-unsafe',
        time: 4,
        type: 'camera',
        params: {
          mode: 'path',
          keyframes: [
            { time: 0, position: [0.5, 0.5] },
            { time: 1, position: [0.9, 0.5], zoom: 1.2 },
          ],
        },
      },
      {
        id: 'focus-character-safe',
        time: 5,
        type: 'camera',
        params: { mode: 'focus', target: 'hero' },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'move-pan-unsafe'))
      .toMatchObject({
        severity: 'warning',
        actionType: 'camera',
        message: expect.stringContaining('黑边'),
      });
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'move-pan-zoom-safe'))
      .toBeUndefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'focus-point-unsafe'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'path-unsafe'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'focus-character-safe'))
      .toBeUndefined();
  });

  it('respects background scale, removal, zoom delta and camera reset', () => {
    const document = makeDocument([
      {
        id: 'bg-set',
        time: 0,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'background', image: 'background/wide.png', scale: 2 },
      },
      {
        id: 'move-pan-covered',
        time: 1,
        type: 'camera',
        params: { mode: 'move', to: [0.7, 0.5] },
      },
      {
        id: 'move-delta-zoom-covered',
        time: 2,
        type: 'camera',
        params: { mode: 'move', to: [0.62, 0.5], zoom: { kind: 'delta', value: 0.3 } },
      },
      {
        id: 'bg-remove',
        time: 3,
        type: 'environmentLayer',
        params: { mode: 'remove', layerId: 'background' },
      },
      {
        id: 'move-no-bg',
        time: 4,
        type: 'camera',
        params: { mode: 'move', to: [0.9, 0.5] },
      },
      {
        id: 'bg-recover',
        time: 5,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'background', image: 'background/room.png' },
      },
      {
        id: 'camera-reset',
        time: 6,
        type: 'camera',
        params: { mode: 'reset' },
      },
      {
        id: 'move-after-reset-unsafe',
        time: 7,
        type: 'camera',
        params: { mode: 'move', to: [0.75, 0.5] },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'move-pan-covered'))
      .toBeUndefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'move-delta-zoom-covered'))
      .toBeUndefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'move-no-bg'))
      .toBeUndefined();
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'move-after-reset-unsafe'))
      .toBeDefined();
  });

  it('uses the bottom-most environment layer as the backdrop', () => {
    const document = makeDocument([
      {
        id: 'bg-room',
        time: 0,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'room', image: 'background/room.png' },
      },
      {
        id: 'bg-fog',
        time: 1,
        type: 'environmentLayer',
        params: { mode: 'set', layerId: 'fog', image: 'background/fog.png', z: 3, scale: 2 },
      },
      {
        id: 'move-pan-unsafe',
        time: 2,
        type: 'camera',
        params: { mode: 'move', to: [0.7, 0.5] },
      },
      {
        id: 'bg-room-remove',
        time: 3,
        type: 'environmentLayer',
        params: { mode: 'remove', layerId: 'room' },
      },
      {
        id: 'move-pan-covered-by-fog',
        time: 4,
        type: 'camera',
        params: { mode: 'move', to: [0.7, 0.5] },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'move-pan-unsafe'))
      .toMatchObject({ message: expect.stringContaining('「room」') });
    expect(issueFor(issues, SEMANTIC_VISUAL_DIAGNOSTIC_CODES.cameraBlackEdge, 'move-pan-covered-by-fog'))
      .toBeUndefined();
  });

  it('surfaces codec-preserved missing IDs through the ValidationDaemon fast path', () => {
    const documentStore = new DocumentStore();
    const validationStore = new ValidationStore();
    const projectResources = {
      getCurrentProject: () => null,
      resolveForRead: async (path: string) => path,
    } as unknown as ProjectResourceService;
    const daemon = new ValidationDaemon(
      documentStore,
      validationStore,
      projectResources,
      () => '',
    );

    daemon.start();
    documentStore._replaceCurrentSceneDocumentSnapshot(sceneDocumentCodec.parseAndValidate({
      schemaVersion: 4,
      sceneId: 'daemon-diagnostics',
      meta: { title: 'Daemon diagnostics' },
      statements: [{
        id: 'daemon-overlay-remove',
        time: 0,
        type: 'lighting',
        params: { effect: 'overlay', mode: 'remove' },
      }],
    }));

    expect(validationStore.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionId: 'daemon-overlay-remove',
        actionType: 'lighting',
        code: SEMANTIC_VISUAL_DIAGNOSTIC_CODES.lightingOverlayMissingId,
        location: 'scene.statements["daemon-overlay-remove"].params.id',
      }),
    ]));
    daemon.dispose();
  });

  it('leaves a whole missing external library to the project dependency scan', async () => {
    const { daemon, validationStore, resolveStatus, document } = makeMountDaemon({
      status: 'mount-unbound',
      mountId: 'library',
      reference: '@mount/library/vocal/line.ogg',
      relativePath: 'vocal/line.ogg',
    });

    await runMountValidation(daemon, document);

    expect(resolveStatus).toHaveBeenCalledWith('@mount/library/vocal/line.ogg');
    // A missing library is aggregated once per mount by the project dependency
    // scan; repeating it per statement flooded the panel with generic rows.
    expect(issuesForStatement(validationStore, 'mounted-voice')).toEqual([]);
  });

  it('still reports a specific file that is missing from a bound library', async () => {
    const { daemon, validationStore, document } = makeMountDaemon({
      status: 'asset-missing',
      mountId: 'library',
      reference: '@mount/library/vocal/line.ogg',
      relativePath: 'vocal/line.ogg',
      path: 'E:/Library/vocal/line.ogg',
      root: 'E:/Library',
      boundVia: 'project-binding',
    });

    await runMountValidation(daemon, document);

    expect(issuesForStatement(validationStore, 'mounted-voice')).toEqual([
      expect.objectContaining({
        actionId: 'mounted-voice',
        code: 'resource.missing',
        location: 'scene.statements["mounted-voice"].params',
        message: expect.stringContaining('library/vocal/line.ogg'),
      }),
    ]);
  });
});

function makeMountDaemon(resolution: ResourceResolution) {
  const documentStore = new DocumentStore();
  const validationStore = new ValidationStore();
  const resolveStatus = vi.fn(async () => resolution);
  const projectResources = {
    getCurrentProject: () => ({ rootPath: 'D:/project' }),
    resolveForRead: async (relativePath: string) => `D:/project/${relativePath}`,
    resolveStatus,
  } as unknown as ProjectResourceService;
  const daemon = new ValidationDaemon(documentStore, validationStore, projectResources, () => 'D:/project');
  const document = makeDocument([{
    id: 'mounted-voice',
    time: 0,
    type: 'dialogue',
    params: { speakerId: 'hero', text: 'Missing mount', durationSeconds: 1, voice: '@mount/library/vocal/line.ogg' },
  }]);
  documentStore._replaceCurrentSceneDocumentSnapshot(document);
  (daemon as any).lastVersion = documentStore.version;
  return { daemon, validationStore, resolveStatus, document };
}

async function runMountValidation(
  daemon: ValidationDaemon,
  document: ReturnType<typeof makeDocument>,
): Promise<void> {
  await (daemon as any).runSemanticAsyncValidation(document);
}

function issuesForStatement(validationStore: ValidationStore, actionId: string) {
  return validationStore.issues.filter((issue) => issue.actionId === actionId);
}
