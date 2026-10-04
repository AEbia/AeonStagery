import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  buildCharacterBindingPlan,
  materializePerformancePlaceholders,
  projectDraftSemanticScene,
} from '../services/ai-authoring/CharacterBindingPlan';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';

function emptyDocument(characters: CurrentSceneDocument['meta']['characters'] = []): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-1',
    meta: {
      title: 'Test',
      characters,
    },
    statements: [],
  };
}

describe('CharacterBindingPlan', () => {
  it('reuses unique same-name scene characters and preallocates missing ids without writing meta', () => {
    const document = emptyDocument([
      { id: 'c-alice', name: 'Alice' },
    ]);

    const plan = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice', 'Bob'],
      requestedBindings: {},
    });

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.bindings.Alice).toEqual({
      name: 'Alice',
      speakerId: 'c-alice',
      source: 'existing_unique',
    });
    expect(plan.bindings.Bob.source).toBe('preallocated');
    expect(plan.bindings.Bob.speakerId).toMatch(/^char_/);
    expect(document.meta.characters).toEqual([{ id: 'c-alice', name: 'Alice' }]);
  });

  it('pauses on ambiguous duplicate names without a user selection', () => {
    const document = emptyDocument([
      { id: 'c1', name: 'Alice' },
      { id: 'c2', name: 'Alice' },
    ]);

    const plan = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice'],
      requestedBindings: {},
    });

    expect(plan.status).toBe('ambiguous');
    if (plan.status !== 'ambiguous') return;
    expect(plan.ambiguous[0]).toMatchObject({
      name: 'Alice',
      candidateIds: ['c1', 'c2'],
    });
  });

  it('accepts explicit disambiguation for duplicate names', () => {
    const document = emptyDocument([
      { id: 'c1', name: 'Alice' },
      { id: 'c2', name: 'Alice' },
    ]);

    const plan = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice'],
      requestedBindings: { Alice: 'c2' },
    });

    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.bindings.Alice).toEqual({
      name: 'Alice',
      speakerId: 'c2',
      source: 'user_disambiguation',
    });
  });
});

describe('performance placeholders', () => {
  it('attaches exactly one empty-motion characterPerformance companion per bound dialogue', () => {
    const document: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene-1',
      meta: {
        title: 'Test',
        characters: [{ id: 'c-alice', name: 'Alice' }],
      },
      statements: [
        {
          id: 'dlg-1',
          time: 0,
          type: 'dialogue',
          params: {
            speakerId: 'c-alice',
            speaker: 'Alice',
            text: '你好。',
            durationSeconds: 1,
          },
        },
        {
          id: 'dlg-2',
          time: 2,
          type: 'dialogue',
          params: {
            speaker: '路人',
            text: '借过。',
            durationSeconds: 1,
          },
        },
        {
          id: 'dlg-3',
          time: 4,
          type: 'dialogue',
          params: {
            text: '旁白。',
            durationSeconds: 1,
          },
        },
      ],
    };

    const next = materializePerformancePlaceholders(document);
    const bound = next.statements.find((statement) => statement.id === 'dlg-1');
    expect(bound?.type).toBe('dialogue');
    if (bound?.type !== 'dialogue') return;
    expect(bound.companions).toHaveLength(1);
    expect(bound.companions?.[0]).toMatchObject({
      anchor: 'start',
      offset: 0,
      type: 'characterPerformance',
      params: {
        target: '$speaker',
        motion: '',
      },
    });

    const temporary = next.statements.find((statement) => statement.id === 'dlg-2');
    expect(temporary?.type).toBe('dialogue');
    if (temporary?.type === 'dialogue') {
      expect(temporary.companions ?? []).toHaveLength(0);
    }

    const narration = next.statements.find((statement) => statement.id === 'dlg-3');
    expect(narration?.type).toBe('dialogue');
    if (narration?.type === 'dialogue') {
      expect(narration.companions ?? []).toHaveLength(0);
    }

    const validated = sceneDocumentCodec.parseAndValidate(next);
    const compiled = sceneStatementCompiler.compile(validated);
    expect(
      compiled.actions.every((action) => (action as { type?: string }).type !== 'playMotion'),
    ).toBe(true);

    const again = materializePerformancePlaceholders(validated);
    const againBound = again.statements.find((statement) => statement.id === 'dlg-1');
    expect(againBound?.type).toBe('dialogue');
    if (againBound?.type === 'dialogue') {
      expect(againBound.companions).toHaveLength(1);
    }
  });

  it('still attaches empty-motion placeholder when dialogue only has expression performance', () => {
    const document: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene-1',
      meta: {
        title: 'Test',
        characters: [{ id: 'c-alice', name: 'Alice' }],
      },
      statements: [
        {
          id: 'dlg-1',
          time: 0,
          type: 'dialogue',
          params: {
            speakerId: 'c-alice',
            speaker: 'Alice',
            text: '你好。',
            durationSeconds: 1,
          },
          companions: [{
            id: 'cmp_expr',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: {
              target: '$speaker',
              expression: 'smile',
            },
          }],
        },
      ],
    };

    const next = materializePerformancePlaceholders(document);
    const bound = next.statements.find((statement) => statement.id === 'dlg-1');
    expect(bound?.type).toBe('dialogue');
    if (bound?.type !== 'dialogue') return;
    expect(bound.companions).toHaveLength(2);
    expect(bound.companions?.some((companion) => (
      companion.type === 'characterPerformance'
      && (companion.params as { motion?: unknown }).motion === ''
    ))).toBe(true);
  });

  it('projects preallocated characters into the projected scene meta without touching the formal document', () => {
    const document = emptyDocument([{ id: 'c-alice', name: 'Alice' }]);
    const plan = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice', 'Bob'],
      requestedBindings: {},
    });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;

    const projected = projectDraftSemanticScene({
      baseDocument: document,
      plan,
      confirmedMainCharacters: ['Alice', 'Bob'],
      previewStatements: [
        {
          speaker: 'Bob',
          text: '你好。',
          time: 1,
          durationSeconds: 1,
        },
      ],
    });

    const bobId = plan.bindings.Bob!.speakerId;
    expect(projected.meta.characters?.some(
      (character) => character.id === bobId && character.name === 'Bob',
    )).toBe(true);
    expect(projected.meta.characters?.some((character) => character.id === 'c-alice')).toBe(true);
    // The formal document keeps its character directory untouched.
    expect(document.meta.characters).toEqual([{ id: 'c-alice', name: 'Alice' }]);
  });

  it('projects draft preview into a non-writing semantic scene with bindings and placeholders', () => {
    const document = emptyDocument([{ id: 'c-alice', name: 'Alice' }]);
    const plan = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice'],
      requestedBindings: {},
    });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;

    const projected = projectDraftSemanticScene({
      baseDocument: document,
      plan,
      confirmedMainCharacters: ['Alice'],
      previewStatements: [
        {
          speaker: 'Alice',
          text: '你好。',
          time: 1,
          durationSeconds: 1.5,
        },
        {
          speaker: '',
          text: '她点头。',
          time: 3,
          durationSeconds: 1,
        },
        {
          speaker: '店员',
          text: '欢迎光临。',
          time: 5,
          durationSeconds: 1,
        },
      ],
    });

    expect(projected.meta.characters).toEqual(document.meta.characters);
    expect(projected.statements).toHaveLength(3);
    const alice = projected.statements[0];
    expect(alice.type).toBe('dialogue');
    if (alice.type !== 'dialogue') return;
    expect(alice.params.speakerId).toBe('c-alice');
    expect(alice.companions).toHaveLength(1);
    expect(alice.companions?.[0].params).toMatchObject({
      target: '$speaker',
      motion: '',
    });

    const temporary = projected.statements[2];
    expect(temporary.type).toBe('dialogue');
    if (temporary.type === 'dialogue') {
      expect(temporary.params.speakerId).toBeUndefined();
      expect(temporary.companions ?? []).toHaveLength(0);
    }

    sceneDocumentCodec.parseAndValidate(projected);
  });
});
