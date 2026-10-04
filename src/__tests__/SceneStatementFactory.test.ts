import { describe, expect, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import {
  encodeCompiledActionId,
  SceneStatementFactory,
  sceneStatementCompiler,
} from '../services/semantic-scene';

function deterministicFactory(ids: readonly string[]): SceneStatementFactory {
  let index = 0;
  return new SceneStatementFactory({
    idGenerator: (prefix) => ids[index++] ?? `${prefix}_${index}`,
  });
}

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_factory',
    meta: {
      title: 'Factory Scene',
      durationSeconds: 1,
      characters: [
        { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
      ],
    },
    statements: [
      {
        id: 'line_1',
        time: 0,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: 'First',
          durationSeconds: 1,
        },
        companions: [
          {
            id: 'focus-speaker',
            anchor: 'start',
            offset: 0,
            type: 'camera',
            params: {
              mode: 'focus',
              target: '$speaker',
              durationSeconds: 0.25,
            },
          },
        ],
      },
    ],
  };
}

describe('SceneStatementFactory', () => {
  it('materializes scene and statement ids before codec validation', () => {
    const factory = deterministicFactory(['scene_1', 'line_1', 'cmp_focus']);
    const document = factory.createDocument({
      meta: {
        title: 'Created Scene',
        characters: [
          { id: 'tomori', name: 'Tomori' },
        ],
      },
      statements: [
        {
          type: 'dialogue',
          params: {
            speakerId: 'tomori',
            text: 'Created',
            durationSeconds: 2,
          },
          companions: [
            {
              type: 'camera',
              params: {
                mode: 'focus',
                target: '$speaker',
                durationSeconds: 0.5,
              },
            },
          ],
        },
      ],
    });

    expect(document.sceneId).toBe('scene_1');
    expect(document.statements[0].id).toBe('line_1');
    expect(document.statements[0].time).toBe(0);
    expect(document.statements[0].companions?.[0].id).toBe('cmp_focus');

    const compiled = sceneStatementCompiler.compile(document);
    expect(compiled.actions.map((action) => action.id)).toEqual([
      encodeCompiledActionId('line_1', undefined, 'primary'),
      encodeCompiledActionId('line_1', 'cmp_focus', 'primary'),
    ]);
  });

  it('inserts by time while preserving author order for equal-time statements', () => {
    const factory = deterministicFactory(['line_2', 'line_3']);
    const document = factory.insertStatement(makeDocument(), {
      type: 'dialogue',
      time: 0,
      params: {
        speakerId: 'tomori',
        text: 'Same time',
        durationSeconds: 1,
      },
    });
    const nextDocument = factory.insertStatement(document, {
      type: 'dialogue',
      time: 0.5,
      params: {
        speakerId: 'tomori',
        text: 'Later',
        durationSeconds: 2,
      },
    });

    expect(nextDocument.statements.map((statement) => [statement.id, statement.time])).toEqual([
      ['line_1', 0],
      ['line_2', 0],
      ['line_3', 0.5],
    ]);
    expect(nextDocument.meta.durationSeconds).toBe(2.5);
  });

  it('duplicates root statements with a new root id and retained companion ids', () => {
    const factory = deterministicFactory(['line_2']);
    const document = factory.duplicateStatement(makeDocument(), 'line_1', {
      timeOffsetSeconds: 2,
    });
    const duplicate = document.statements.find((statement) => statement.id === 'line_2');

    expect(duplicate?.time).toBe(2);
    expect(duplicate?.companions?.map((companion) => companion.id)).toEqual(['focus-speaker']);

    const compiled = sceneStatementCompiler.compile(document);
    expect(compiled.actions.map((action) => action.id)).toEqual([
      encodeCompiledActionId('line_1', undefined, 'primary'),
      encodeCompiledActionId('line_1', 'focus-speaker', 'primary'),
      encodeCompiledActionId('line_2', undefined, 'primary'),
      encodeCompiledActionId('line_2', 'focus-speaker', 'primary'),
    ]);
  });

  it('keeps dialogue companions scoped to dialogue parents', () => {
    const factory = deterministicFactory(['env_1']);
    const document = factory.insertStatement(makeDocument(), {
      type: 'environmentLayer',
      time: 1,
      params: {
        mode: 'set',
        layerId: 'background',
        image: 'background/classroom.png',
      },
    });

    expect(() => factory.appendDialogueCompanion(document, 'env_1', {
      type: 'camera',
      params: {
        mode: 'focus',
        position: [0.5, 0.5],
      },
    })).toThrow(/Only dialogue statements/);
  });
});
