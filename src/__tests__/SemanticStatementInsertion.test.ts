import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSemanticStatementLibraryInsert, submitSemanticStatementLibraryInsert } from '../ui/timeline/semanticStatementInsertion';
import { DEFAULT_SETTINGS, settingsManager } from '../ui/SettingsStore';

describe('semantic statement library insertion', () => {
  afterEach(() => {
    settingsManager.set('defaultDialogueDurationSeconds', DEFAULT_SETTINGS.defaultDialogueDurationSeconds);
  });

  it('builds an insert-statement intent with the list origin and no scope inference', () => {
    const result = buildSemanticStatementLibraryInsert({
      blockId: 'dialogue.basic',
      document: null,
      sceneMeta: { title: 'List insertion', characters: [{ id: 'hero', name: 'Hero' }] },
      anchorTime: 1.2,
      origin: 'timeline-list-gap',
      scope: { kind: 'none' },
    });

    expect(result).toMatchObject({
      kind: 'intent',
      intent: {
        kind: 'insert-statement',
        origin: 'timeline-list-gap',
        anchorTime: 1.2,
        scope: { kind: 'none' },
        statement: {
          type: 'dialogue',
          params: { text: '新对白', durationSeconds: 2 },
        },
      },
    });
  });

  it('uses the configured default duration for dialogue insert intents', () => {
    settingsManager.set('defaultDialogueDurationSeconds', 3.5);

    const result = buildSemanticStatementLibraryInsert({
      blockId: 'dialogue.basic',
      document: null,
      sceneMeta: { title: 'List insertion' },
      anchorTime: 1.2,
      origin: 'timeline-list-gap',
      scope: { kind: 'none' },
    });

    expect(result).toMatchObject({
      kind: 'intent',
      intent: {
        statement: {
          type: 'dialogue',
          params: { text: '新对白', durationSeconds: 3.5 },
        },
      },
    });
  });

  it('selects root compiled actions after a semantic insert is committed', async () => {
    const author = vi.fn(async () => ({ createdStatementIds: ['created'] } as any));
    const onSelect = vi.fn();
    const intent = buildSemanticStatementLibraryInsert({
      blockId: 'dialogue.basic',
      document: null,
      sceneMeta: { title: 'List insertion' },
      anchorTime: 0.8,
      origin: 'timeline-list-gap',
      scope: { kind: 'none' },
    });
    if (intent.kind !== 'intent') throw new Error('expected insert intent');

    await submitSemanticStatementLibraryInsert({
      semanticAuthoring: { author },
      documentStore: {
        getCompiledSceneSnapshot: () => ({
          actions: [{ id: 'compiled-created', source: { statementId: 'created' } }],
        } as any),
      },
      intent: intent.intent,
      onSelect,
    });

    expect(author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'insert-statement',
      anchorTime: 0.8,
      origin: 'timeline-list-gap',
    }));
    expect(onSelect).toHaveBeenCalledWith(['compiled-created']);
  });

  it('includes beforeStatementId in the intent when specified', () => {
    const result = buildSemanticStatementLibraryInsert({
      blockId: 'dialogue.basic',
      document: null,
      sceneMeta: { title: 'List insertion' },
      anchorTime: 1.5,
      origin: 'timeline-list-gap',
      scope: { kind: 'none' },
      beforeStatementId: 'stmt-next',
    });

    expect(result).toMatchObject({
      kind: 'intent',
      intent: {
        kind: 'insert-statement',
        origin: 'timeline-list-gap',
        anchorTime: 1.5,
        beforeStatementId: 'stmt-next',
      },
    });
  });
});
