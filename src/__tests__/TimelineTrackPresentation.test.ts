import { describe, expect, it } from 'vitest';
import type { TimelineAction, TimelineScene } from '../ui/timeline/semanticTimelineTypes';
import { createSemanticStatementDraftForBlock } from '../ui/timeline/semanticStatementBlocks';
import { buildTimelineTracks, getTimelineTrackId, isCharacterTrackAction } from '../ui/timeline/timelineTrackPresentation';

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
    expect(environmentTrack?.actions.find(({ id }) => id === 'transform-layer')?.action.params.label).toBe('前景雾');
    expect(tracks.some((track) => track.id === 'lens')).toBe(false);
    expect(tracks.some((track) => track.id.startsWith('env:'))).toBe(false);
    expect(tracks[tracks.length - 2]?.id).toBe('environment');
    expect(tracks[tracks.length - 1]?.id).toBe('bgm');
  });

  it('keeps the environment track at the bottom when no BGM track is visible', () => {
    const tracks = buildTimelineTracks(sceneWithoutBgm);
    expect(tracks[tracks.length - 1]?.id).toBe('environment');
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
    ];

    for (const candidate of cases) {
      expect(getTimelineTrackId(classificationScene, candidate)).toBe('char:char-1');
      expect(isCharacterTrackAction(classificationScene, candidate)).toBe(true);
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
