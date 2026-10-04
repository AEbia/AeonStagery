import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { evaluateFirstLessonCompletion } from '../services/onboarding/FirstLessonCompletion';

function makeDocument(overrides: Partial<CurrentSceneDocument> = {}): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'tutorial',
    meta: {
      title: '教程练习',
      characters: [],
      markers: [],
    },
    statements: [],
    ...overrides,
  };
}

describe('FirstLessonCompletion', () => {
  it('returns the first unmet business step in order', () => {
    expect(evaluateFirstLessonCompletion({
      assetSourceReady: false,
      document: null,
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'prepare-asset-source',
      satisfiedSteps: [],
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: makeDocument(),
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'create-character',
      satisfiedSteps: ['prepare-asset-source'],
    });
  });

  it('requires an explicitly available model when availability is supplied', () => {
    const document = makeDocument({
      meta: {
        title: '教程练习',
        characters: [{ id: 'anon', name: 'Anon', model: '@mount/webgal/anon/model.json' }],
      },
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document,
      modelAvailabilityByReference: { '@mount/webgal/anon/model.json': false },
    })).toMatchObject({
      firstUnmetStep: 'select-character-model',
      selectedCharacterId: null,
      selectedModelReference: null,
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document,
      modelAvailabilityByReference: { '@mount/webgal/anon/model.json': true },
    })).toMatchObject({
      firstUnmetStep: 'insert-character-entrance',
      selectedCharacterId: 'anon',
      selectedModelReference: '@mount/webgal/anon/model.json',
    });
  });

  it('requires entrance display, dialogue resize/move, a Live2D motion, and preview start', () => {
    const document = makeDocument({
      meta: {
        title: '教程练习',
        characters: [{ id: 'anon', name: 'Anon', model: 'figure/anon/model.json' }],
      },
      statements: [
        {
          id: 'enter-anon',
          time: 0,
          type: 'characterPresence',
          params: { mode: 'enter', id: 'anon' },
        },
        {
          id: 'env-bg',
          time: 0,
          type: 'environmentLayer',
          params: { mode: 'set', layerId: 'background', file: 'background/bg.png' },
        },
        {
          id: 'dialogue-1',
          time: 1,
          type: 'dialogue',
          params: { speakerId: 'anon', text: '我已经改过对白。', durationSeconds: 2 },
        },
      ],
    });
    const dialogueBaselines = { 'dialogue-1': { time: 1, duration: 2 } };

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document,
      runtime: {
        visibleModelCharacterIds: ['anon'],
        hasPlayedCharacterEntrance: false,
        hasStartedPreview: false,
        dialogueBaselines,
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'insert-character-entrance',
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document,
      runtime: {
        visibleModelCharacterIds: ['anon'],
        hasPlayedCharacterEntrance: true,
        hasStartedPreview: false,
        dialogueBaselines,
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'resize-dialogue-duration',
      satisfiedSteps: [
        'prepare-asset-source',
        'create-character',
        'select-character-model',
        'insert-character-entrance',
        'insert-environment-background',
        'add-and-edit-dialogue',
      ],
    });

    const resizedDocument = makeDocument({
      ...document,
      statements: [
        ...document.statements.map((statement) => (
          statement.type === 'dialogue'
            ? { ...statement, params: { ...statement.params, durationSeconds: 3.5 } }
            : statement
        )),
      ],
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: resizedDocument,
      runtime: {
        visibleModelCharacterIds: ['anon'],
        hasPlayedCharacterEntrance: true,
        hasStartedPreview: false,
        dialogueBaselines,
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'move-dialogue-time',
      satisfiedSteps: [
        'prepare-asset-source',
        'create-character',
        'select-character-model',
        'insert-character-entrance',
        'insert-environment-background',
        'add-and-edit-dialogue',
        'resize-dialogue-duration',
      ],
    });

    const movedDocument = makeDocument({
      ...resizedDocument,
      statements: [
        ...resizedDocument.statements.map((statement) => (
          statement.id === 'dialogue-1'
            ? { ...statement, time: 2.5 }
            : statement
        )),
      ],
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: movedDocument,
      runtime: {
        visibleModelCharacterIds: ['anon'],
        hasPlayedCharacterEntrance: true,
        hasStartedPreview: false,
        dialogueBaselines,
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'add-live2d-motion',
      satisfiedSteps: [
        'prepare-asset-source',
        'create-character',
        'select-character-model',
        'insert-character-entrance',
        'insert-environment-background',
        'add-and-edit-dialogue',
        'resize-dialogue-duration',
        'move-dialogue-time',
      ],
    });

    const documentWithMotion = makeDocument({
      ...movedDocument,
      statements: [
        ...movedDocument.statements,
        {
          id: 'motion-1',
          time: 2,
          type: 'characterPerformance',
          params: { target: 'anon', motion: { kind: 'resource', key: 'wave' } },
        },
      ],
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: documentWithMotion,
      runtime: {
        visibleModelCharacterIds: ['anon'],
        hasPlayedCharacterEntrance: true,
        hasStartedPreview: false,
        dialogueBaselines,
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'preview-live2d-motion',
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: documentWithMotion,
      runtime: {
        visibleModelCharacterIds: ['anon'],
        hasPlayedCharacterEntrance: true,
        hasStartedPreview: true,
        hasPreviewedLive2DMotion: true,
        dialogueBaselines,
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'insert-camera-focus',
    });
  });

  it('requires a dialogue change relative to the recorded baseline', () => {
    const document = makeDocument({
      meta: {
        title: '教程练习',
        characters: [{ id: 'anon', name: 'Anon', model: 'figure/anon/model.json' }],
      },
      statements: [
        {
          id: 'enter-anon',
          time: 0,
          type: 'characterPresence',
          params: { mode: 'enter', id: 'anon' },
        },
        {
          id: 'env-bg',
          time: 0,
          type: 'environmentLayer',
          params: { mode: 'set', layerId: 'background', file: 'background/bg.png' },
        },
        {
          id: 'line-1',
          time: 1,
          type: 'dialogue',
          params: { speakerId: 'anon', text: '改过的台词', durationSeconds: 2 },
        },
      ],
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document,
      runtime: {
        visibleModelCharacterIds: ['anon'],
        hasPlayedCharacterEntrance: true,
        dialogueBaselines: { 'line-1': { time: 1, duration: 2 } },
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'resize-dialogue-duration',
    });

    const resized = makeDocument({
      ...document,
      statements: [
        ...document.statements.map((statement) => (
          statement.type === 'dialogue'
            ? { ...statement, params: { ...statement.params, durationSeconds: 3 } }
            : statement
        )),
      ],
    });
    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: resized,
      runtime: {
        visibleModelCharacterIds: ['anon'],
        hasPlayedCharacterEntrance: true,
        dialogueBaselines: { 'line-1': { time: 1, duration: 2 } },
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'move-dialogue-time',
    });

    const moved = makeDocument({
      ...resized,
      statements: [
        ...resized.statements.map((statement) => (
          statement.type === 'dialogue'
            ? { ...statement, time: 3.2 }
            : statement
        )),
      ],
    });
    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: moved,
      runtime: {
        visibleModelCharacterIds: ['anon'],
        hasPlayedCharacterEntrance: true,
        dialogueBaselines: { 'line-1': { time: 1, duration: 2 } },
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'add-live2d-motion',
    });
  });

  it('does not accept the default newly inserted dialogue text as edited', () => {
    const document = makeDocument({
      meta: {
        title: '教程练习',
        characters: [{ id: 'anon', name: 'Anon', model: 'figure/anon/model.json' }],
      },
      statements: [
        {
          id: 'line-1',
          time: 0,
          type: 'dialogue',
          params: { speakerId: 'anon', text: '新对白', durationSeconds: 2 },
        },
      ],
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document,
    })).toMatchObject({
      firstUnmetStep: 'insert-character-entrance',
      satisfiedSteps: ['prepare-asset-source', 'create-character', 'select-character-model'],
    });
  });

  it('requires a camera focus statement, a focus-part change, and preview', () => {
    const completedDocument = makeDocument({
      meta: {
        title: '教程练习',
        characters: [{ id: 'anon', name: 'Anon', model: 'figure/anon/model.json' }],
      },
      statements: [
        {
          id: 'enter-anon',
          time: 0,
          type: 'characterPresence',
          params: { mode: 'enter', id: 'anon' },
        },
        {
          id: 'env-bg',
          time: 0,
          type: 'environmentLayer',
          params: { mode: 'set', layerId: 'background', file: 'background/bg.png' },
        },
        {
          id: 'line-1',
          time: 2,
          type: 'dialogue',
          params: { speakerId: 'anon', text: '已经改过的对白', durationSeconds: 3 },
        },
        {
          id: 'motion-1',
          time: 2,
          type: 'characterPerformance',
          params: { target: 'anon', motion: { kind: 'resource', key: 'wave' } },
        },
      ],
    });
    const runtime = {
      visibleModelCharacterIds: ['anon'],
      hasPlayedCharacterEntrance: true,
      hasPreviewedLive2DMotion: true,
      hasStartedPreview: true,
      dialogueBaselines: { 'line-1': { time: 1, duration: 2 } },
    };

    const withFocusStatement = makeDocument({
      ...completedDocument,
      statements: [
        ...completedDocument.statements,
        {
          id: 'camera-focus-1',
          time: 1,
          type: 'camera',
          params: { mode: 'focus', target: 'anon', targetPart: 'chest' },
        },
      ],
    });
    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: withFocusStatement,
      runtime: {
        ...runtime,
        cameraFocusPartBaselines: { 'camera-focus-1': 'chest' },
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'tune-camera-focus-part',
      satisfiedSteps: expect.arrayContaining(['insert-camera-focus']),
    });

    const withTunedFocus = makeDocument({
      ...withFocusStatement,
      statements: [
        ...withFocusStatement.statements.filter((statement) => statement.id !== 'camera-focus-1'),
        {
          id: 'camera-focus-1',
          time: 1,
          type: 'camera',
          params: { mode: 'focus', target: 'anon', targetPart: 'head' },
        },
      ],
    });
    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: withTunedFocus,
      runtime: {
        ...runtime,
        cameraFocusPartBaselines: { 'camera-focus-1': 'chest' },
      },
    })).toMatchObject({
      completed: true,
      firstUnmetStep: null,
    });
  });

  it('does not accept an unchanged focus part or an empty baseline record', () => {
    const document = makeDocument({
      meta: {
        title: '教程练习',
        characters: [{ id: 'anon', name: 'Anon', model: 'figure/anon/model.json' }],
      },
      statements: [
        {
          id: 'enter-anon',
          time: 0,
          type: 'characterPresence',
          params: { mode: 'enter', id: 'anon' },
        },
        {
          id: 'env-bg',
          time: 0,
          type: 'environmentLayer',
          params: { mode: 'set', layerId: 'background', file: 'background/bg.png' },
        },
        {
          id: 'line-1',
          time: 2,
          type: 'dialogue',
          params: { speakerId: 'anon', text: '已经改过的对白', durationSeconds: 3 },
        },
        {
          id: 'motion-1',
          time: 2,
          type: 'characterPerformance',
          params: { target: 'anon', motion: { kind: 'resource', key: 'wave' } },
        },
        {
          id: 'camera-focus-1',
          time: 1,
          type: 'camera',
          params: { mode: 'focus', target: 'anon', targetPart: 'chest' },
        },
      ],
    });
    const runtime = {
      visibleModelCharacterIds: ['anon'],
      hasPlayedCharacterEntrance: true,
      hasPreviewedLive2DMotion: true,
      hasStartedPreview: true,
      dialogueBaselines: { 'line-1': { time: 1, duration: 2 } },
    };

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document,
      runtime: {
        ...runtime,
        cameraFocusPartBaselines: { 'camera-focus-1': 'chest' },
      },
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'tune-camera-focus-part',
    });

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document,
      runtime,
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'tune-camera-focus-part',
    });
  });

  it('requires an environment background with an image after the entrance', () => {
    const document = makeDocument({
      meta: {
        title: '教程练习',
        characters: [{ id: 'anon', name: 'Anon', model: 'figure/anon/model.json' }],
      },
      statements: [
        {
          id: 'enter-anon',
          time: 0,
          type: 'characterPresence',
          params: { mode: 'enter', id: 'anon' },
        },
      ],
    });
    const entranceRuntime = {
      visibleModelCharacterIds: ['anon'],
      hasPlayedCharacterEntrance: true,
    };

    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document,
      runtime: entranceRuntime,
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'insert-environment-background',
    });

    const emptyFileEnvironment = makeDocument({
      ...document,
      statements: [
        ...document.statements,
        {
          id: 'env-bg',
          time: 0,
          type: 'environmentLayer',
          params: { mode: 'set', layerId: 'background', file: '' },
        },
      ],
    });
    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: emptyFileEnvironment,
      runtime: entranceRuntime,
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'insert-environment-background',
    });

    const setEnvironment = makeDocument({
      ...document,
      statements: [
        ...document.statements,
        {
          id: 'env-bg',
          time: 0,
          type: 'environmentLayer',
          params: { mode: 'set', layerId: 'background', file: 'background/bg.png' },
        },
      ],
    });
    expect(evaluateFirstLessonCompletion({
      assetSourceReady: true,
      document: setEnvironment,
      runtime: entranceRuntime,
    })).toMatchObject({
      completed: false,
      firstUnmetStep: 'add-and-edit-dialogue',
      satisfiedSteps: expect.arrayContaining(['insert-environment-background']),
    });
  });
});
