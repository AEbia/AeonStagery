import { describe, expect, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import {
  applyCharacterDirectoryCommandToCurrentSceneDocument,
} from '../services/character-directory/SemanticCharacterDirectory';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_v2',
    meta: {
      title: 'Semantic Character Directory',
      fps: 60,
      characters: [
        { id: '1', name: '旧名', model: 'models/old.json', color: '#123456' },
        { id: '2', name: '配角', model: 'models/side.json' },
      ],
    },
    statements: [
      {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: '1',
          speaker: '旧名',
          text: '你好',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'focus',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '1',
              durationSeconds: 0.5,
            },
          },
          {
            id: 'smile',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: '1',
              expression: 'smile',
              lookAt: { target: '1' },
            },
          },
        ],
      },
      {
        id: 'enter',
        time: 1.2,
        type: 'characterPresence',
        params: {
          mode: 'enter',
          id: '1',
          model: 'models/old.json',
          durationSeconds: 1,
        },
      },
      {
        id: 'move',
        time: 2,
        type: 'characterTransform',
        params: {
          id: '1',
          position: [0.2, 0.4],
          durationSeconds: 1,
        },
      },
      {
        id: 'motion',
        time: 3,
        type: 'characterPerformance',
        params: {
          target: '1',
          motion: { kind: 'resource', key: 'idle' },
          lookAt: { target: '1' },
        },
      },
      {
        id: 'follow',
        time: 4,
        type: 'camera',
        params: {
          mode: 'follow',
          operation: 'start',
          target: '1',
        },
      },
      {
        id: 'hitchcock',
        time: 5,
        type: 'camera',
        params: {
          mode: 'hitchcock',
          target: '1',
          zoomStart: 1,
          zoomEnd: 1.2,
          scaleStart: 1,
          scaleEnd: 1.1,
          durationSeconds: 1,
        },
      },
      {
        id: 'custom',
        time: 6,
        type: 'customAnimation',
        params: {
          target: '1',
          file: 'animations/wave.json',
          durationSeconds: 1,
        },
      },
    ],
  };
}

describe('SemanticCharacterDirectory', () => {
  it('adds the first character without materializing an invalid empty model', () => {
    const result = applyCharacterDirectoryCommandToCurrentSceneDocument({
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'empty_scene',
      meta: { title: 'Empty', characters: [] },
      statements: [],
    }, {
      kind: 'add-character',
      origin: 'workspace-tools-panel',
    });

    expect(result.document.meta.characters).toEqual([
      { id: '1', name: '新角色' },
    ]);
  });

  it('updates character ids across source statements and dialogue companions without mutating input', () => {
    const document = makeDocument();
    const before = JSON.parse(JSON.stringify(document)) as CurrentSceneDocument;

    const result = applyCharacterDirectoryCommandToCurrentSceneDocument(document, {
      kind: 'update-character-id',
      origin: 'timeline-list-view',
      currentCharId: '1',
      nextCharId: 'hero',
    });

    expect(document).toEqual(before);
    expect(result.receipt).toEqual({
      kind: 'update-character-id',
      origin: 'timeline-list-view',
      affectedCharacterIds: ['hero'],
      affectedStatementIds: ['line_1', 'enter', 'move', 'motion', 'follow', 'hitchcock', 'custom'],
      affectedCompanionLocators: [
        { statementId: 'line_1', companionId: 'focus' },
        { statementId: 'line_1', companionId: 'smile' },
      ],
    });

    expect(result.document.meta.characters?.find((character) => character.name === '旧名')?.id).toBe('hero');
    expect(result.document.statements.find((statement) => statement.id === 'line_1')?.params)
      .toMatchObject({ speakerId: 'hero' });
    expect(result.document.statements.find((statement) => statement.id === 'enter')?.params)
      .toMatchObject({ id: 'hero' });
    expect(result.document.statements.find((statement) => statement.id === 'move')?.params)
      .toMatchObject({ id: 'hero' });
    expect(result.document.statements.find((statement) => statement.id === 'motion')?.params)
      .toMatchObject({ target: 'hero', lookAt: { target: 'hero' } });
    expect(result.document.statements.find((statement) => statement.id === 'follow')?.params)
      .toMatchObject({ target: 'hero' });
    expect(result.document.statements.find((statement) => statement.id === 'hitchcock')?.params)
      .toMatchObject({ target: 'hero' });
    expect(result.document.statements.find((statement) => statement.id === 'custom')?.params)
      .toMatchObject({ target: 'hero' });

    const line = result.document.statements.find((statement) => statement.id === 'line_1');
    expect(line?.companions?.find((companion) => companion.id === 'focus')?.params)
      .toMatchObject({ target: 'hero' });
    expect(line?.companions?.find((companion) => companion.id === 'smile')?.params)
      .toMatchObject({ target: 'hero', lookAt: { target: 'hero' } });
  });

  it('updates character names on source dialogue labels only when speakerId matches', () => {
    const result = applyCharacterDirectoryCommandToCurrentSceneDocument(makeDocument(), {
      kind: 'update-character-name',
      origin: 'workspace-tools-panel',
      charId: '1',
      nextName: '千早',
    });

    expect(result.receipt).toEqual({
      kind: 'update-character-name',
      origin: 'workspace-tools-panel',
      affectedCharacterIds: ['1'],
      affectedStatementIds: ['line_1'],
      affectedCompanionLocators: [],
    });
    expect(result.document.meta.characters?.find((character) => character.id === '1')?.name).toBe('千早');
    expect(result.document.statements.find((statement) => statement.id === 'line_1')?.params)
      .toMatchObject({ speakerId: '1', speaker: '千早' });
  });

  it('updates character model metadata and enter statements without touching unrelated statements', () => {
    const result = applyCharacterDirectoryCommandToCurrentSceneDocument(makeDocument(), {
      kind: 'set-character-model',
      origin: 'timeline-list-view',
      charId: '1',
      model: 'models/new.json',
    });

    expect(result.receipt).toEqual({
      kind: 'set-character-model',
      origin: 'timeline-list-view',
      affectedCharacterIds: ['1'],
      affectedStatementIds: ['enter'],
      affectedCompanionLocators: [],
    });
    expect(result.document.meta.characters?.find((character) => character.id === '1')?.model).toBe('models/new.json');
    expect(result.document.statements.find((statement) => statement.id === 'enter')?.params)
      .toMatchObject({ model: 'models/new.json' });
  });

  it('adds multiple non-empty model variants to one character', () => {
    const first = applyCharacterDirectoryCommandToCurrentSceneDocument(makeDocument(), {
      kind: 'add-character-variant',
      origin: 'workspace-tools-panel',
      charId: '1',
      model: 'models/winter.json',
    });
    const second = applyCharacterDirectoryCommandToCurrentSceneDocument(first.document, {
      kind: 'add-character-variant',
      origin: 'workspace-tools-panel',
      charId: '1',
      model: 'models/summer.json',
    });

    expect(second.document.meta.characters?.find((character) => character.id === '1')?.variants).toEqual([
      { name: '副模型1', model: 'models/winter.json' },
      { name: '副模型2', model: 'models/summer.json' },
    ]);
    expect(() => applyCharacterDirectoryCommandToCurrentSceneDocument(second.document, {
      kind: 'add-character-variant',
      origin: 'workspace-tools-panel',
      charId: '1',
      model: '   ',
    })).toThrow('Variant model is required');
  });

  it('removes an optional character model instead of storing an invalid empty string', () => {
    const result = applyCharacterDirectoryCommandToCurrentSceneDocument(makeDocument(), {
      kind: 'set-character-model',
      origin: 'workspace-tools-panel',
      charId: '2',
    });

    expect(result.document.meta.characters?.find((character) => character.id === '2'))
      .not.toHaveProperty('model');
  });

  it('imports new template characters while preserving duplicate ids without new variants', () => {
    const result = applyCharacterDirectoryCommandToCurrentSceneDocument(makeDocument(), {
      kind: 'add-template-characters',
      origin: 'template-config',
      characters: [
        { id: '2', name: '重复', model: 'models/duplicate.json' },
        { id: 'tomori', name: 'Tomori', model: 'models/tomori.json' },
      ],
    });

    expect(result.receipt).toEqual({
      kind: 'add-template-characters',
      origin: 'template-config',
      affectedCharacterIds: ['tomori'],
      affectedStatementIds: [],
      affectedCompanionLocators: [],
    });
    expect(result.document.meta.characters?.map((character) => character.id)).toEqual(['1', '2', 'tomori']);
  });

  it('adds missing template variants to an existing character', () => {
    const result = applyCharacterDirectoryCommandToCurrentSceneDocument(makeDocument(), {
      kind: 'add-template-characters',
      origin: 'template-config',
      characters: [
        {
          id: '1',
          name: '模板名称不覆盖本地名称',
          model: 'models/template-primary.json',
          variants: [
            { name: '默认', model: 'models/primary.json' },
            { name: '冬装', model: 'models/winter.json' },
          ],
        },
      ],
    });

    expect(result.receipt.affectedCharacterIds).toEqual(['1']);
    expect(result.document.meta.characters?.find((character) => character.id === '1')).toMatchObject({
      name: '旧名',
      model: 'models/old.json',
      variants: [
        { name: '默认', model: 'models/primary.json' },
        { name: '冬装', model: 'models/winter.json' },
      ],
    });
  });

  it('rejects renaming a character onto an id another character already uses', () => {
    const document = makeDocument();

    expect(() => applyCharacterDirectoryCommandToCurrentSceneDocument(document, {
      kind: 'update-character-id',
      origin: 'workspace-tools-panel',
      currentCharId: '1',
      nextCharId: '2',
    })).toThrow('Duplicate character id: 2');

    expect(() => applyCharacterDirectoryCommandToCurrentSceneDocument(document, {
      kind: 'update-character-id',
      origin: 'workspace-tools-panel',
      currentCharId: '1',
      nextCharId: '   ',
    })).toThrow('Character id must not be empty');

    expect(document.meta.characters?.map((character) => character.id)).toEqual(['1', '2']);
  });

  it('allows re-saving a character under its current id', () => {
    const result = applyCharacterDirectoryCommandToCurrentSceneDocument(makeDocument(), {
      kind: 'update-character-id',
      origin: 'workspace-tools-panel',
      currentCharId: '1',
      nextCharId: '1',
    });

    expect(result.document.meta.characters?.map((character) => character.id)).toEqual(['1', '2']);
  });
});
