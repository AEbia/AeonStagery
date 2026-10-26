import { describe, expect, it } from 'vitest';
import type { TimelineAction, TimelineScene } from '../ui/timeline/semanticTimelineTypes';
import { createSemanticStatementDraftForBlock } from '../ui/timeline/semanticStatementBlocks';
import { buildTimelineTracks, getTimelineTrackId, isCharacterTrackAction } from '../ui/timeline/timelineTrackPresentation';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { buildSemanticStatementLibraryInsert } from '../ui/timeline/semanticStatementInsertion';
import { buildSemanticTimelineReadModel } from '../ui/timeline/semanticTimelineReadModel';

const sceneWithBgm: TimelineScene = {
  sceneId: 'timeline-track-presentation',
  meta: {
    title: 'timeline-track-presentation',
    characters: [{ id: '1', name: '灯' }],
  },
  timeline: [
    { _id: 'cam', time: 0, action: 'cameraMotion', params: { move: 'push', easing: 'smooth', duration: 1 } },
    { _id: 'bg', time: 0, action: 'setBackground', params: { image: 'bg.png', duration: 0 } },
    { _id: 'set-layer', time: 1, action: 'setEnvironmentLayer', params: { layerId: 'fog-bank', label: '前景雾', image: 'fog.png' } },
    { _id: 'transform-layer', time: 2, action: 'transformEnvironmentLayer', params: { layerId: 'fog-bank', duration: 1, x: 0.4 } },
    { _id: 'lens', time: 3, action: 'addLensFilter', params: { category: 'grade', recipeId: 'builtin:default-grade' } },
    { _id: 'dialogue', time: 4, action: 'dialogue', params: { speakerId: '1', text: 'hi', duration: 2 } },
    { _id: 'bgm', time: 5, action: 'setBGM', params: { file: 'bgm.mp3' } },
  ],
};

const sceneWithoutBgm: TimelineScene = {
  ...sceneWithBgm,
  sceneId: 'timeline-track-no-bgm',
  timeline: sceneWithBgm.timeline.filter((action) => action.action !== 'setBGM'),
};

describe('timelineTrackPresentation', () => {
  it('builds a single unified environment track and places it above BGM', () => {
    const tracks = buildTimelineTracks(sceneWithBgm);
    const environmentTrack = tracks.find((track) => track.id === 'environment');

    expect(environmentTrack?.label).toBe('环境画面');
    expect(environmentTrack?.actions.map(({ action }) => action.action)).toEqual([
      'setBackground',
      'setEnvironmentLayer',
      'transformEnvironmentLayer',
    ]);
    expect(environmentTrack?.actions.find(({ id }) => id === 'transform-layer')?.action.params.label).toBe('fog-bank');
    expect(environmentTrack?.actions.find(({ id }) => id === 'set-layer')?.action.params.label).toBe('fog-bank');
    expect(tracks.some((track) => track.id === 'lens')).toBe(false);
    expect(tracks.some((track) => track.id.startsWith('env:'))).toBe(false);
    expect(tracks[tracks.length - 2]?.id).toBe('environment');
    expect(tracks[tracks.length - 1]?.id).toBe('bgm');
  });

  it('keeps the environment track at the bottom when no BGM track is visible', () => {
    const tracks = buildTimelineTracks(sceneWithoutBgm);
    expect(tracks[tracks.length - 1]?.id).toBe('environment');
  });

  it.each(['setBlur', 'resetBlur', 'setPostProcessing', 'resetPostProcessing'])(
    'places %s for individual environment layers on the environment row', (actionType) => {
      for (const target of ['fog-bank', 'environmentLayer:fog-bank', 'environmentLayer:1']) {
        const candidate = action({ action: actionType, params: { target } });
        expect(getTimelineTrackId(sceneWithBgm, candidate)).toBe('environment');
        expect(isCharacterTrackAction(sceneWithBgm, candidate)).toBe(false);
      }
    },
  );

  it.each(['blur', 'post'] as const)('keeps environment %s lifecycle blocks on the environment row before and after compilation', (effect) => {
    const document = sceneDocumentCodec.parseAndValidate({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'environment-lighting',
      meta: { title: 'Environment lighting', characters: [{ id: 'background', name: '主角' }] },
      statements: ['set', 'modulate', 'reset'].map((mode, index) => ({
        id: mode,
        time: index + 1,
        type: 'lighting',
        params: { effect, mode, target: { kind: 'group', group: 'environmentLayers' } },
      })),
    });

    for (const compiled of [sceneStatementCompiler.compile(document), null]) {
      const scene: TimelineScene = {
        sceneId: document.sceneId,
        meta: document.meta,
        timeline: buildSemanticTimelineReadModel(document, compiled).map((item) => item.displayAction),
      };
      const tracks = buildTimelineTracks(scene);
      expect(tracks.find((track) => track.id === 'environment')?.actions.map(({ action }) => action.time)).toEqual([1, 2, 3]);
      expect(tracks.find((track) => track.id === 'global')?.actions).toHaveLength(0);
      expect(tracks.find((track) => track.id === 'char:background')?.actions).toHaveLength(0);
    }
  });
});

const classificationScene = {
  sceneId: 'scene-1',
  meta: {
    title: '测试场景',
    characters: [{ id: 'char-1', name: '角色一' }],
  },
  timeline: [],
} as TimelineScene;

function action(input: Partial<TimelineAction> & Pick<TimelineAction, 'action'>): TimelineAction {
  return {
    params: {},
    ...input,
  };
}

describe('timeline track target classification', () => {
  it.each([
    ['blur', 'hero'],
    ['post', 'hero'],
    ['blur', 'background'],
    ['post', 'panorama'],
    ['blur', 'group:characters'],
    ['post', 'environmentLayer:fog'],
  ] as const)('keeps %s inserted from character %s on that character track throughout its lifecycle', (effect, charId) => {
    let document: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'character-lighting-insert',
      meta: {
        title: 'Character lighting insertion',
        characters: [{ id: 'bystander', name: '旁观者' }, { id: charId, name: '主角' }],
      },
      statements: [],
    };

    const blocks = [`lighting.${effect}`, `lighting.modulate-${effect}`, `lighting.reset-${effect}`];
    for (const [index, blockId] of blocks.entries()) {
      const time = index + 1;
      const result = buildSemanticStatementLibraryInsert({
        blockId,
        document,
        sceneMeta: document.meta,
        anchorTime: time,
        origin: 'blank-context-menu',
        scope: { kind: 'inferred-character', charId, source: 'blank-menu-track' },
      });
      expect(result.kind).toBe('intent');
      if (result.kind !== 'intent') throw new Error(`Cannot insert ${blockId}`);
      expect(result.intent.statement.params).toMatchObject({ target: { kind: 'character', id: charId } });
      document = sceneDocumentCodec.parseAndValidate({
        ...document,
        statements: [...document.statements, { ...result.intent.statement, id: blockId, time }],
      });
    }

    // The timeline must retain the row while compilation is pending as well.
    for (const compiled of [sceneStatementCompiler.compile(document), null]) {
      const scene: TimelineScene = {
        sceneId: document.sceneId,
        meta: document.meta,
        timeline: buildSemanticTimelineReadModel(document, compiled).map((item) => item.displayAction),
      };
      const tracks = buildTimelineTracks(scene);
      const characterTrack = tracks.find((track) => track.id === `char:${charId}`);
      expect(characterTrack?.actions.map(({ action }) => action.time)).toEqual([1, 2, 3]);
      expect(tracks.find((track) => track.id === 'global')?.actions).toHaveLength(0);
      expect(tracks.find((track) => track.id === 'char:bystander')?.actions).toHaveLength(0);
    }
  });

  it('does not treat non-character ids as character track targets', () => {
    const cases: Array<[TimelineAction, string]> = [
      [action({ action: 'addImage', params: { id: 'image_ee6e5745' } }), 'global'],
      [action({ action: 'addTextLayer', params: { id: 'text_1' } }), 'global'],
      [action({ action: 'playAudio', params: { id: 'sfx_1' } }), 'audio'],
      [action({ action: 'stopAudio', params: { id: 'bgm' } }), 'audio'],
      [action({ action: 'addPointLight', params: { id: 'light_1' } }), 'global'],
      [action({ action: 'addColorOverlay', params: { id: 'overlay_1' } }), 'global'],
    ];

    for (const [candidate, expectedTrack] of cases) {
      expect(getTimelineTrackId(classificationScene, candidate)).toBe(expectedTrack);
      expect(isCharacterTrackAction(classificationScene, candidate)).toBe(false);
    }
  });

  it('keeps character actions and character-targeted visual actions on character tracks', () => {
    const cases: TimelineAction[] = [
      action({ action: 'addCharacter', params: { id: 'char-1' } }),
      action({ action: 'playMotion', params: { id: 'char-1' } }),
      action({ action: 'dialogue', params: { speakerId: 'char-1' } }),
      action({ action: 'setCompositeRecipe', params: { targetId: 'char-1' } }),
      action({ action: 'setBlur', params: { target: 'char-1' } }),
      action({ action: 'resetBlur', params: { target: 'character:char-1' } }),
      action({ action: 'setPostProcessing', params: { target: 'character:char-1' } }),
      action({ action: 'resetPostProcessing', params: { target: 'char-1' } }),
    ];

    for (const candidate of cases) {
      expect(getTimelineTrackId(classificationScene, candidate)).toBe('char:char-1');
      expect(isCharacterTrackAction(classificationScene, candidate)).toBe(true);
    }
  });

  it.each(['blur', 'post'] as const)('keeps %s scene, group and environment targets off character tracks', (effect) => {
    const scene: TimelineScene = {
      ...classificationScene,
      meta: {
        ...classificationScene.meta,
        characters: [
          'char-1', 'global', 'background', 'characters', 'all', 'panorama',
          'group:characters', 'group:environmentLayers',
        ].map((id) => ({ id, name: id })),
      },
    };
    const targets = [
      undefined, '', { kind: 'group', group: 'characters' }, { kind: 'group', group: 'environmentLayers' }, { kind: 'environmentLayer', id: 'char-1' }, 'unknown',
      ...(effect === 'blur' ? ['global', 'background', 'characters'] : ['panorama']),
    ];
    const actionTypes = effect === 'blur' ? ['setBlur', 'resetBlur'] : ['setPostProcessing', 'resetPostProcessing'];
    for (const target of targets) {
      const candidates = [
        ...actionTypes.map((actionType) => action({ action: actionType, params: { target } })),
        action({ action: 'lighting', semanticType: 'lighting', params: { effect, target } }),
      ];
      for (const candidate of candidates) {
        const expectedTrack = (typeof target === 'object' && (target.kind === 'environmentLayer' || (target.kind === 'group' && target.group === 'environmentLayers')))
          || (effect === 'blur' && target === 'background') ? 'environment' : 'global';
        expect(getTimelineTrackId(scene, candidate)).toBe(expectedTrack);
        expect(isCharacterTrackAction(scene, candidate)).toBe(false);
      }
    }
  });

  it('keeps the runtime all sentinel global while the source ID all stays on its character track', () => {
    const scene: TimelineScene = {
      ...classificationScene,
      meta: { ...classificationScene.meta, characters: [{ id: 'all', name: 'All' }] },
    };
    const source = action({ action: 'lighting', semanticType: 'lighting', params: { effect: 'blur', target: 'all' } });
    const compiled = action({ action: 'resetBlur', params: { target: 'character:all' } });
    for (const candidate of [source, compiled]) {
      expect(getTimelineTrackId(scene, candidate)).toBe('char:all');
      expect(isCharacterTrackAction(scene, candidate)).toBe(true);
    }
    for (const actionType of ['setBlur', 'resetBlur']) {
      const candidate = action({ action: actionType, params: { target: 'all' } });
      expect(getTimelineTrackId(scene, candidate)).toBe('global');
      expect(isCharacterTrackAction(scene, candidate)).toBe(false);
    }
  });

  it('places $speaker performance placeholders on the resolved speaker track', () => {
    const scene: TimelineScene = {
      ...classificationScene,
      timeline: [
        action({
          action: 'characterPerformance',
          semanticType: 'characterPerformance',
          params: { target: '$speaker', motion: '' },
          sourceParams: { target: '$speaker', motion: '' },
          resolvedSpeakerId: 'char-1',
        }),
      ],
    };

    expect(getTimelineTrackId(scene, scene.timeline[0])).toBe('char:char-1');
    expect(isCharacterTrackAction(scene, scene.timeline[0])).toBe(true);
  });

  it('falls back to the raw target when no resolved speaker is stamped', () => {
    const scene: TimelineScene = {
      ...classificationScene,
      timeline: [
        action({
          action: 'characterPerformance',
          semanticType: 'characterPerformance',
          params: { target: '$speaker', motion: '' },
          sourceParams: { target: '$speaker', motion: '' },
        }),
      ],
    };

    expect(getTimelineTrackId(scene, scene.timeline[0])).toBe('char:$speaker');
  });

  it('allows an image-layer draft to be completed later in the inspector', () => {
    const draft = createSemanticStatementDraftForBlock('graphic.image', {});

    expect(draft).toMatchObject({
      type: 'graphicLayer',
      params: {
        kind: 'image',
        mode: 'set',
        file: '',
        position: [0.5, 0.5],
        scale: 1,
      },
    });
  });
});
