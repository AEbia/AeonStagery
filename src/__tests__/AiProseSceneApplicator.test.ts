import { describe, expect, it } from 'vitest';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';
import {
  getSceneDocumentCanonicalOrder,
  withSceneDocumentCanonicalOrder,
} from '../services/semantic-scene';
import type { AiProseDraftSession } from '../api/types/ai-prose-authoring';
import {
  AiProseSceneApplicator,
  type AiProseSceneApplicationReceipt,
} from '../services/ai-authoring/AiProseSceneApplicator';
import { duplicateAppliedDraft } from '../services/ai-authoring/AiProseDraftSession';
import { buildAiProseDeterministicPreview } from '../services/ai-authoring/AiProseDeterministicCompiler';
import { materializePerformancePlaceholders } from '../services/ai-authoring/CharacterBindingPlan';
import { buildCharacterBindingPlan } from '../services/ai-authoring/CharacterBindingPlan';
import { SemanticSceneLineView } from '../services/semantic-scene/SemanticSceneLineView';
import { SEMANTIC_SCENE_PATCH_VERSION } from '../api/types/semantic-scene-patch';
import { combineStagePatches } from '../services/ai-authoring/FormalEnhancementApply';

function makeDraft(): AiProseDraftSession {
  return withDeterministicPreview({
    schemaVersion: 3,
    sessionId: 'session-1',
    sceneId: 'scene-1',
    sourceText: 'Alice 走进房间。',
    sourceRevision: 0,
    anchorMode: 'playhead',
    anchorTime: 10,
    targetBatchSize: 4000,
    scriptReadingSpeed: 7,
    status: 'active',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    segmentation: {
      status: 'succeeded',
      planFingerprint: 'applicator-plan',
      targetSegmentCount: 1,
      candidates: [],
      boundaryIds: [],
      segments: [{
        index: 0,
        startOffset: 0,
        endOffset: 13,
        sourceText: 'Alice 走进房间。',
      }],
    },
    characterExtraction: {
      status: 'succeeded',
      suggestedNames: ['Alice'],
    },
    confirmedMainCharacters: ['Alice'],
    mainCharactersConfirmed: true,
    normalization: [{
      segmentIndex: 0,
      status: 'succeeded',
      statements: [
        { speaker: 'Alice', text: '你好。' },
        { speaker: '', text: '她放下杯子。' },
        { speaker: 'Bystander', text: '请留步。' },
      ],
    }],
    rhythm: [{
      segmentIndex: 0,
      status: 'succeeded',
      gapSeconds: [1, 1],
    }],
    preview: {
      anchorTime: 10,
      durationSeconds: 5,
      statements: [
        {
          segmentIndex: 0,
          statementIndex: 0,
          speaker: 'Alice',
          text: '你好。',
          time: 10,
          durationSeconds: 1,
          gapSecondsToNext: 1,
        },
        {
          segmentIndex: 0,
          statementIndex: 1,
          speaker: '',
          text: '她放下杯子。',
          time: 12,
          durationSeconds: 1,
          gapSecondsToNext: 1,
        },
        {
          segmentIndex: 0,
          statementIndex: 2,
          speaker: 'Bystander',
          text: '请留步。',
          time: 14,
          durationSeconds: 1,
          gapSecondsToNext: 0,
        },
      ],
    },
    characterBindings: {},
  });
}

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-1',
    meta: {
      title: 'Application target',
      characters: [{
        id: 'character-alice',
        name: 'Alice',
        model: 'models/alice.model3.json',
        color: '#ffffff',
        voiceProfileId: 'voice-alice',
        variants: [{ name: 'default', model: 'models/alice.model3.json' }],
      }],
    },
    statements: [{
      id: 'existing-line',
      time: 20,
      type: 'dialogue',
      params: {
        speaker: 'Alice',
        speakerId: 'character-alice',
        text: 'existing',
        durationSeconds: 2,
      },
    }],
  };
}

function withDeterministicPreview(draft: AiProseDraftSession): AiProseDraftSession {
  return {
    ...draft,
    preview: buildAiProseDeterministicPreview(
      draft.normalization,
      draft.rhythm,
      draft.anchorTime,
      { scriptReadingSpeed: draft.scriptReadingSpeed },
    ),
  };
}

function makeDraftWithStatements(
  mainCharacters: readonly string[],
  statements: ReadonlyArray<{
    speaker: string;
    text: string;
    time: number;
    durationSeconds: number;
    gapSecondsToNext: number;
  }>,
  anchorTime = 10,
): AiProseDraftSession {
  const base = { ...makeDraft(), anchorTime };
  return withDeterministicPreview({
    ...base,
    characterExtraction: {
      status: 'succeeded',
      suggestedNames: [...mainCharacters],
    },
    confirmedMainCharacters: [...mainCharacters],
    normalization: [{
      segmentIndex: 0,
      status: 'succeeded',
      statements: statements.map(({ speaker, text }) => ({ speaker, text })),
    }],
    rhythm: [{
      segmentIndex: 0,
      status: 'succeeded',
      gapSeconds: statements.slice(0, -1).map(({ gapSecondsToNext }) => gapSecondsToNext),
    }],
    preview: {
      anchorTime: base.anchorTime,
      durationSeconds: statements.length === 0
        ? 0
        : statements.at(-1)!.time + statements.at(-1)!.durationSeconds - base.anchorTime,
      statements: statements.map((statement, statementIndex) => ({
        ...statement,
        segmentIndex: 0,
        statementIndex,
      })),
    },
    characterBindings: {},
  });
}

describe('AiProseSceneApplicator', () => {
  it('recomputes the preview with the injected reading speed and rejects stale timing', async () => {
    const draft = makeDraft();
    const deterministic = buildAiProseDeterministicPreview(
      draft.normalization,
      draft.rhythm,
      draft.anchorTime,
      { scriptReadingSpeed: 14 },
    );
    const preparedDraft = {
      ...draft,
      scriptReadingSpeed: 14,
      preview: deterministic,
    };
    const committed: CurrentSceneDocument[] = [];
    const applicator = new AiProseSceneApplicator({
      commitApplied: ({ document: nextDocument }) => {
        committed.push(nextDocument);
      },
    });

    const result = await applicator.apply(preparedDraft, makeDocument());

    expect(result.document.statements.filter((statement) => statement.type === 'dialogue'))
      .toHaveLength(deterministic.statements.length + 1);
    expect(committed).toHaveLength(1);

    await expect(applicator.apply({
      ...preparedDraft,
      sessionId: 'stale-session',
      preview: {
        ...deterministic,
        statements: deterministic.statements.map((statement, index) => (
          index === 0 ? { ...statement, durationSeconds: statement.durationSeconds + 0.1 } : statement
        )),
      },
    }, makeDocument())).rejects.toThrow(/deterministic|preview/i);
  });

  it('uses the reading speed persisted on the draft during application', async () => {
    const draftBase = {
      ...makeDraftWithStatements(['Alice'], [{
        speaker: 'Alice',
        text: `${'甲'.repeat(20)}。`,
        time: 10,
        durationSeconds: 1.8,
        gapSecondsToNext: 0,
      }]),
      scriptReadingSpeed: 14,
    };
    const draft = {
      ...draftBase,
      preview: buildAiProseDeterministicPreview(
        draftBase.normalization,
        draftBase.rhythm,
        draftBase.anchorTime,
        { scriptReadingSpeed: draftBase.scriptReadingSpeed },
      ),
    };

    const result = await new AiProseSceneApplicator({
      commitApplied: () => undefined,
    }).apply(draft, makeDocument());

    expect(result.document.statements.find((statement) => (
      statement.type === 'dialogue' && statement.params.text.startsWith('甲')
    ))?.params).toMatchObject({ durationSeconds: 1.8 });
  });

  it('preserves a fractional playhead anchor through deterministic compilation and application', async () => {
    const draft = makeDraftWithStatements(['Alice'], [{
      speaker: 'Alice',
      text: '固定锚点。',
      time: 12.34,
      durationSeconds: 1,
      gapSecondsToNext: 0,
    }], 12.34);
    const deterministic = buildAiProseDeterministicPreview(
      draft.normalization,
      draft.rhythm,
      draft.anchorTime,
    );
    const result = await new AiProseSceneApplicator({
      commitApplied: () => undefined,
    }).apply({ ...draft, preview: deterministic }, makeDocument());

    expect(deterministic.anchorTime).toBe(12.34);
    expect(deterministic.statements[0].time).toBe(12.34);
    expect(result.document.statements.find((statement) => (
      statement.type === 'dialogue' && statement.params.text === '固定锚点。'
    ))?.time).toBe(12.34);
  });

  it('preserves non-enumerable canonical statement order while applying', async () => {
    const baseDocument = makeDocument();
    const document = withSceneDocumentCanonicalOrder({
      ...baseDocument,
      statements: [
        baseDocument.statements[0],
        { ...baseDocument.statements[0], id: 'early-line', time: 5 },
      ],
    }, ['early-line', 'existing-line']);
    const result = await new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: () => 'generated-line',
    }).apply(makeDraftWithStatements(['Alice'], [{
      speaker: 'Alice',
      text: '中间语句。',
      time: 10,
      durationSeconds: 1,
      gapSecondsToNext: 0,
    }]), document);

    const order = getSceneDocumentCanonicalOrder(result.document);
    expect(order).toEqual(['early-line', 'generated-line', 'existing-line']);
    expect(Object.keys(result.document)).not.toContain('sceneDocumentCanonicalOrder');
  });

  it('applies narration-only drafts with an explicitly confirmed empty character list', async () => {
    const result = await new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: () => 'narration-only',
    }).apply(makeDraftWithStatements([], [{
      speaker: '',
      text: '只有旁白。',
      time: 0,
      durationSeconds: 1,
      gapSecondsToNext: 0,
    }], 0), {
      ...makeDocument(),
      meta: { title: 'Narration target' },
      statements: [],
    });

    expect(result.receipt.createdCharacterIds).toEqual([]);
    expect(result.document.meta.characters).toBeUndefined();
    expect(result.document.statements[0].params).toEqual({
      text: '只有旁白。',
      durationSeconds: 0.9,
    });
  });

  it('materializes confirmed, temporary, and narration speakers in one direct commit', async () => {
    const draft = makeDraft();
    const document = makeDocument();
    const before = structuredClone(document);
    const committed: CurrentSceneDocument[] = [];
    let statementId = 0;
    const applicator = new AiProseSceneApplicator({
      commitApplied: ({ document: nextDocument }) => {
        committed.push(nextDocument);
      },
      statementIdGenerator: (prefix) => `${prefix}_generated_${statementId += 1}`,
      characterIdGenerator: () => 'unused-character-id',
    });

    const result = await applicator.apply(draft, document);

    expect(committed).toHaveLength(1);
    expect(result.document).toBe(committed[0]);
    expect(document).toEqual(before);
    expect(result.receipt).toEqual(expect.objectContaining<Partial<AiProseSceneApplicationReceipt>>({
      sessionId: 'session-1',
      sceneId: 'scene-1',
      createdCharacterIds: [],
      characterBindings: { Alice: 'character-alice' },
      createdStatementIds: [
        'dlg_generated_1',
        'dlg_generated_2',
        'dlg_generated_3',
      ],
      timeRange: { start: 10, end: 14.5 },
    }));
    expect(result.archive.version).toBe(1);
    expect(result.archive.status).toBe('applied');

    expect(result.document.meta.characters).toEqual(makeDocument().meta.characters);
    expect(result.document.statements.map((statement) => statement.time)).toEqual([10, 11.7, 13.6, 20]);
    expect(result.document.statements.slice(0, 3).map((statement) => statement.params)).toEqual([
      {
        speaker: 'Alice',
        speakerId: 'character-alice',
        text: '你好。',
        durationSeconds: 0.9,
      },
      {
        text: '她放下杯子。',
        durationSeconds: 1.1,
      },
      {
        speaker: 'Bystander',
        text: '请留步。',
        durationSeconds: 0.9,
      },
    ]);
  });

  it('does not backfill performance placeholders into pre-existing bound dialogues', async () => {
    const document = makeDocument();
    const existingBefore = document.statements.find((statement) => statement.id === 'existing-line');
    expect(existingBefore?.type).toBe('dialogue');
    if (existingBefore?.type === 'dialogue') {
      expect(existingBefore.companions ?? []).toHaveLength(0);
    }
    let statementId = 0;
    const result = await new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: (prefix) => `${prefix}_nobackfill_${statementId += 1}`,
    }).apply(makeDraft(), document);

    const existingAfter = result.document.statements.find((statement) => statement.id === 'existing-line');
    expect(existingAfter?.type).toBe('dialogue');
    if (existingAfter?.type === 'dialogue') {
      // ADR-0022: placeholders only ever attach to the dialogues created by this draft.
      expect(existingAfter.companions ?? []).toHaveLength(0);
    }
    const created = result.document.statements.filter((statement) => (
      statement.type === 'dialogue' && statement.id.startsWith('dlg_nobackfill_')
    ));
    expect(created).toHaveLength(3);
    for (const statement of created) {
      expect(statement.type).toBe('dialogue');
      if (statement.type === 'dialogue') {
        const placeholders = (statement.companions ?? []).filter((companion) => (
          companion.type === 'characterPerformance'
          && (companion.params as { target?: unknown }).target === '$speaker'
          && companion.anchor === 'start'
          && companion.offset === 0
        ));
        // ADR-0022: exactly one placeholder per bound created dialogue; the
        // temporary speaker and narration created dialogues stay placeholder-free.
        expect(placeholders).toHaveLength(
          typeof statement.params.speakerId === 'string' && statement.params.speakerId !== '' ? 1 : 0,
        );
      }
    }
  });

  it('creates a new main character with only an id and exact name', async () => {
    const draft = makeDraftWithStatements(['NewHero'], [{
      speaker: 'NewHero',
      text: 'new line',
      time: 10,
      durationSeconds: 1.4,
      gapSecondsToNext: 0,
    }]);
    const document = makeDocument();
    let committed: CurrentSceneDocument | undefined;
    const applicator = new AiProseSceneApplicator({
      commitApplied: ({ document: nextDocument }) => {
        committed = nextDocument;
      },
      characterIdGenerator: (name, usedIds) => {
        expect(name).toBe('NewHero');
        expect(usedIds.has('character-alice')).toBe(true);
        return 'character-new-hero';
      },
      statementIdGenerator: () => 'new-dialogue',
    });

    const result = await applicator.apply(draft, document);

    expect(committed).toBe(result.document);
    expect(result.receipt.createdCharacterIds).toEqual(['character-new-hero']);
    expect(result.receipt.characterBindings).toEqual({ NewHero: 'character-new-hero' });
    expect(result.document.meta.characters).toEqual([
      ...makeDocument().meta.characters!,
      { id: 'character-new-hero', name: 'NewHero' },
    ]);
    expect(result.document.statements[0].params).toEqual({
      speaker: 'NewHero',
      speakerId: 'character-new-hero',
      text: 'new line',
      durationSeconds: 1.4,
    });
  });

  it('rejects duplicate main-character names before commit when no binding is selected', async () => {
    const draft = makeDraft();
    const document = makeDocument();
    document.meta.characters = [
      { id: 'character-alice', name: 'Existing Alice reference' },
      { id: 'alice-first', name: 'Alice' },
      { id: 'alice-second', name: 'Alice' },
    ];
    let commitCalls = 0;
    const applicator = new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    });

    await expect(applicator.apply(draft, document)).rejects.toThrow(/unresolved.*Alice/);
    expect(commitCalls).toBe(0);
  });

  it('uses the explicitly selected duplicate character id', async () => {
    const draft = {
      ...makeDraft(),
      characterBindings: { Alice: 'alice-second' },
    };
    const document = makeDocument();
    document.meta.characters = [
      { id: 'character-alice', name: 'Existing Alice reference' },
      { id: 'alice-first', name: 'Alice' },
      { id: 'alice-second', name: 'Alice' },
    ];
    let statementId = 0;
    const applicator = new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: (prefix) => `${prefix}-selected-${statementId += 1}`,
    });

    const result = await applicator.apply(draft, document);

    expect(result.receipt.characterBindings).toEqual({ Alice: 'alice-second' });
    const selectedDialogue = result.document.statements.find((statement) => (
      statement.type === 'dialogue' && statement.params.text === '你好。'
    ));
    expect(selectedDialogue?.params).toEqual({
      speaker: 'Alice',
      speakerId: 'alice-second',
      text: '你好。',
      durationSeconds: 0.9,
    });
  });

  it('uses exact speaker names and keeps a near-match temporary', async () => {
    const draft = makeDraftWithStatements(['Alice'], [{
      speaker: 'Alice ',
      text: 'exact matching matters',
      time: 10,
      durationSeconds: 3.2,
      gapSecondsToNext: 0,
    }]);
    const document = makeDocument();
    const applicator = new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: () => 'dlg_exact_name',
    });

    const result = await applicator.apply(draft, document);

    expect(result.receipt.characterBindings).toEqual({ Alice: 'character-alice' });
    expect(result.document.statements[0].params).toEqual({
      speaker: 'Alice ',
      text: 'exact matching matters',
      durationSeconds: 3.2,
    });
    expect(result.document.meta.characters).toHaveLength(1);
  });

  it('rejects a failed normalization task before any scene mutation', async () => {
    const draft = {
      ...makeDraft(),
      normalization: [{
        ...makeDraft().normalization[0],
        status: 'failed' as const,
        error: { code: 'normalization-failed', message: 'failed' },
      }],
    };
    const document = makeDocument();
    let commitCalls = 0;
    const applicator = new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    });

    await expect(applicator.apply(draft, document)).rejects.toThrow();
    expect(commitCalls).toBe(0);
  });

  it('applies an explicitly confirmed list when character extraction failed', async () => {
    const draft = {
      ...makeDraft(),
      characterExtraction: {
        status: 'failed' as const,
        suggestedNames: [],
        error: { code: 'transport-error', message: 'character provider unavailable' },
      },
    };
    const committed: CurrentSceneDocument[] = [];

    const result = await new AiProseSceneApplicator({
      commitApplied: ({ document }) => {
        committed.push(document);
      },
    }).apply(draft, makeDocument());

    expect(committed).toHaveLength(1);
    expect(result.receipt.characterBindings).toEqual({ Alice: 'character-alice' });
  });

  it.each([
    ['unconfirmed', { mainCharactersConfirmed: false }],
    ['already applied', { status: 'applied' as const }],
    ['future schema', { schemaVersion: 99 as 3 }],
    ['corrupt preview', { preview: null }],
  ])('rejects %s drafts before commit', async (_label, patch) => {
    const draft = { ...makeDraft(), ...patch };
    const document = makeDocument();
    let commitCalls = 0;
    const applicator = new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    });

    await expect(applicator.apply(draft, document)).rejects.toThrow();
    expect(commitCalls).toBe(0);
  });

  it('does not leave scene changes or archive state when the single commit fails', async () => {
    const draft = makeDraft();
    const document = makeDocument();
    const before = structuredClone(document);
    const externalFacts = {
      document: structuredClone(document),
      draftStatus: draft.status,
      archive: undefined as unknown,
    };
    const applicator = new AiProseSceneApplicator({
      commitApplied: async () => {
        await Promise.resolve();
        throw new Error('composite commit failed');
      },
    });

    await expect(applicator.apply(draft, document)).rejects.toThrow('composite commit failed');
    expect(document).toEqual(before);
    expect(externalFacts).toEqual({
      document: before,
      draftStatus: 'active',
      archive: undefined,
    });
  });

  it('rejects the legacy split commit and checkpoint seams', () => {
    expect(() => new AiProseSceneApplicator({
      commit: () => undefined,
      checkpointApplied: () => undefined,
    } as never)).toThrow(/commitApplied/);
  });

  it('inserts overlapping preview times directly without changing existing statements', async () => {
    const draft = makeDraftWithStatements(['Alice'], [{
      speaker: 'Alice',
      text: 'overlapping line',
      time: 20,
      durationSeconds: 3,
      gapSecondsToNext: 0,
    }], 20);
    const document = makeDocument();
    let statementId = 0;
    const applicator = new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: (prefix) => `${prefix}_overlap_${statementId += 1}`,
    });

    const result = await applicator.apply(draft, document);

    expect(result.document.statements.map((statement) => ({
      id: statement.id,
      time: statement.time,
      text: statement.type === 'dialogue' ? statement.params.text : undefined,
    }))).toEqual([
      { id: 'existing-line', time: 20, text: 'existing' },
      { id: 'dlg_overlap_1', time: 20, text: 'overlapping line' },
    ]);
  });

  it('extends an existing explicit scene duration to contain the direct insertion', async () => {
    const draft = makeDraftWithStatements(['Alice'], [{
      speaker: 'Alice',
      text: 'later line',
      time: 30,
      durationSeconds: 1,
      gapSecondsToNext: 0,
    }], 30);
    const document = makeDocument();
    document.meta.durationSeconds = 25;
    const applicator = new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: () => 'dlg_duration_extension',
    });

    const result = await applicator.apply(draft, document);

    expect(result.document.meta.durationSeconds).toBe(31.6);
    expect(result.document.statements.find((statement) => statement.id === 'dlg_duration_extension')?.time).toBe(30);
  });

  it('returns a stable default character id and avoids an occupied id', async () => {
    const draft = makeDraftWithStatements(['NewHero'], [{
      speaker: 'NewHero',
      text: 'new line',
      time: 10,
      durationSeconds: 1,
      gapSecondsToNext: 0,
    }]);
    const firstDocument = makeDocument();
    const first = await new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: (prefix) => `${prefix}_stable_1`,
    }).apply(draft, firstDocument);
    const firstId = first.receipt.createdCharacterIds[0];

    const occupiedDocument = makeDocument();
    occupiedDocument.meta.characters = [
      ...occupiedDocument.meta.characters!,
      { id: firstId, name: 'Other' },
    ];
    const second = await new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: (prefix) => `${prefix}_stable_1`,
    }).apply(draft, occupiedDocument);

    expect(firstId).toBeTruthy();
    expect(second.receipt.createdCharacterIds[0]).not.toBe(firstId);
    expect(second.receipt.createdCharacterIds[0]).toMatch(new RegExp(`^${firstId}_`));
    expect(first.receipt.createdCharacterIds[0]).toBe(
      (await new AiProseSceneApplicator({
        commitApplied: () => undefined,
        statementIdGenerator: (prefix) => `${prefix}_stable_1`,
      }).apply(draft, makeDocument())).receipt.createdCharacterIds[0],
    );
  });

  it('archives once through the checkpoint and rejects a second application', async () => {
    const draft = makeDraft();
    const document = makeDocument();
    const archives: unknown[] = [];
    let commitCalls = 0;
    const applicator = new AiProseSceneApplicator({
      commitApplied: ({ archive }) => {
        commitCalls += 1;
        archives.push(archive);
      },
      now: () => '2026-08-03T01:02:03.000Z',
    });

    const result = await applicator.apply(draft, document);

    expect(archives).toEqual([result.archive]);
    expect(draft.status).toBe('active');
    await expect(applicator.apply(draft, document)).rejects.toThrow();
    expect(commitCalls).toBe(1);
  });

  it('atomically commits the scene and applied draft, and locks concurrent applicators', async () => {
    let signalStarted!: () => void;
    let releaseCommit!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const commits: Array<{ draft: AiProseDraftSession; archiveStatus: string }> = [];
    const commitApplied = async (input: {
      previousDocument: CurrentSceneDocument;
      document: CurrentSceneDocument;
      draft: AiProseDraftSession;
      archive: { status: 'applied' };
    }) => {
      signalStarted();
      expect(input.draft.status).toBe('applied');
      commits.push({ draft: input.draft, archiveStatus: input.archive.status });
      await commitGate;
    };
    const draft = makeDraft();
    let statementId = 0;
    const applicator = new AiProseSceneApplicator({
      commitApplied,
      statementIdGenerator: (prefix) => `${prefix}_atomic_${statementId += 1}`,
    });

    const firstApply = applicator.apply(draft, makeDocument());
    await started;
    await expect(applicator.apply(draft, makeDocument())).rejects.toThrow(/concurrent|already applied/i);
    releaseCommit();
    const firstResult = await firstApply;

    expect(commits).toHaveLength(1);
    expect(commits[0].archiveStatus).toBe('applied');
    expect(firstResult.appliedDraft.status).toBe('applied');
    expect(draft.status).toBe('active');

    const newApplicator = new AiProseSceneApplicator({
      commitApplied,
      statementIdGenerator: (prefix) => `${prefix}_new_applicator`,
    });
    await expect(newApplicator.apply(draft, makeDocument())).rejects.toThrow(/already applied/i);
  });

  it('applies draft enhancement stages against the final apply baseline (existing scene + draft dialogues)', async () => {
    // Existing formal dialogue at t=0 occupies early Agent lines after placeholders.
    const formal: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene-1',
      meta: {
        title: 'Application target',
        characters: [{ id: 'character-alice', name: 'Alice' }],
      },
      statements: [{
        id: 'existing-line',
        time: 0,
        type: 'dialogue',
        params: {
          speaker: 'Alice',
          speakerId: 'character-alice',
          text: 'existing',
          durationSeconds: 1,
        },
      }],
    };

    const draft = makeDraftWithStatements(['Alice'], [{
      speaker: 'Alice',
      text: '新对白。',
      time: 10,
      durationSeconds: 1,
      gapSecondsToNext: 0,
    }]);

    // Author enhancement against the same shape apply will produce (not draft-only):
    // placeholders attach only to the draft-created dialogue (ADR-0022 — the
    // pre-existing formal dialogue keeps no placeholder).
    const applyBaseline = materializePerformancePlaceholders({
      ...formal,
      statements: [
        ...formal.statements,
        {
          id: 'draft-dlg',
          time: 10,
          type: 'dialogue',
          params: {
            speaker: 'Alice',
            speakerId: 'character-alice',
            text: '新对白。',
            durationSeconds: 1,
          },
        },
      ],
    }, { targetStatementIds: new Set(['draft-dlg']) });
    const lineView = new SemanticSceneLineView(applyBaseline);
    const draftDialogue = lineView.lines.find(
      (line) => line.kind === 'statement'
        && line.type === 'dialogue'
        && (line.params as { text?: string }).text === '新对白。',
    );
    expect(draftDialogue).toBeTruthy();
    const placeholder = lineView.lines.find(
      (line) => line.kind === 'companion'
        && line.parentLine === draftDialogue!.line
        && line.type === 'characterPerformance',
    );
    expect(placeholder).toBeTruthy();
    // Draft-only projection would have used line 2; with existing scene the placeholder is later.
    expect(placeholder!.line).toBeGreaterThan(2);

    const performancePatch = {
      version: SEMANTIC_SCENE_PATCH_VERSION,
      operations: [{
        kind: 'updateCompanion' as const,
        line: placeholder!.line,
        patch: { params: { motion: 'wave' } },
      }],
    };
    const stagePlan = combineStagePatches(performancePatch, undefined);

    let statementId = 0;
    const result = await new AiProseSceneApplicator({
      commitApplied: () => undefined,
      statementIdGenerator: (prefix) => `${prefix}_enh_${statementId += 1}`,
    }).apply(draft, formal, { enhancementStagePlan: stagePlan });

    const existing = result.document.statements.find((s) => s.id === 'existing-line');
    expect(existing?.type).toBe('dialogue');
    if (existing?.type === 'dialogue') {
      const motion = (existing.companions?.[0]?.params as { motion?: string } | undefined)?.motion;
      expect(motion === '' || motion === undefined).toBe(true);
    }

    const created = result.document.statements.find((s) => (
      s.type === 'dialogue' && s.params.text === '新对白。'
    ));
    expect(created?.type).toBe('dialogue');
    if (created?.type === 'dialogue') {
      expect(created.companions?.[0]?.params).toMatchObject({ motion: { kind: 'resource', key: 'wave' } });
    }
  });

  it('enforces the performance policy for legacy flat enhancement patches', async () => {
    let commitCalled = false;
    await expect(new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalled = true;
      },
    }).apply(makeDraft(), makeDocument(), {
      enhancementPatch: {
        version: SEMANTIC_SCENE_PATCH_VERSION,
        operations: [{ kind: 'deleteLine', line: 1 }],
      },
    })).rejects.toThrow(/not allowed|policy/i);
    expect(commitCalled).toBe(false);
  });

  it('refuses apply when the persisted binding plan conflicts with the latest scene', async () => {
    const draft = makeDraft();
    draft.characterBindingPlan = {
      status: 'ready',
      bindings: {
        Alice: { name: 'Alice', speakerId: 'character-alice', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    };
    const document = makeDocument();
    // Latest scene no longer has the unique Alice character.
    const changed = {
      ...document,
      meta: { ...document.meta, characters: [] },
    };
    let commitCalls = 0;
    await expect(new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    }).apply(draft, changed)).rejects.toMatchObject({ code: 'binding-conflict' });
    expect(commitCalls).toBe(0);
  });

  it('refuses apply when the binding plan is ambiguous at apply time', async () => {
    const draft = makeDraft();
    draft.characterBindingPlan = {
      status: 'ambiguous',
      bindings: {},
      ambiguous: [{ name: 'Alice', candidateIds: ['character-alice', 'character-alice-2'] }],
      preallocatedCharacterIds: [],
    };
    let commitCalls = 0;
    await expect(new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    }).apply(draft, makeDocument())).rejects.toMatchObject({ code: 'binding-conflict' });
    expect(commitCalls).toBe(0);
  });

  it('refuses apply when a target dialogue ends up without exactly one performance placeholder', async () => {
    const draft = makeDraft();
    draft.characterBindingPlan = {
      status: 'ready',
      bindings: {
        Alice: { name: 'Alice', speakerId: 'character-alice', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    };
    const document = makeDocument();
    // A stage plan that duplicates the speaker placeholder on the created
    // dialogue (legal under the performance policy's insertCompanion rule) —
    // the apply-time invariant must still refuse the transaction.
    const stagePlan: import('../services/ai-authoring/FormalEnhancementApply').EnhancementStagePlanV1 = {
      version: 1,
      stages: [{
        stage: 'performance',
        patch: {
          version: SEMANTIC_SCENE_PATCH_VERSION,
          operations: [{
            kind: 'insertCompanion',
            parentLine: 1,
            companion: {
              anchor: 'start',
              offset: 0,
              type: 'characterPerformance',
              params: { target: '$speaker', motion: '' },
            },
          }],
        },
      }],
    };
    let commitCalls = 0;
    await expect(new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    }).apply(draft, document, { enhancementStagePlan: stagePlan })).rejects.toMatchObject({
      code: 'binding-conflict',
    });
    expect(commitCalls).toBe(0);
  });

  it('refuses apply when the user changed a disambiguation choice since plan creation', async () => {
    const draft = makeDraft();
    // The plan was authored with the user picking alice-first; the draft's
    // binding record now points at alice-second (choice changed without
    // regenerating the plan) — apply must not silently follow the draft.
    draft.characterBindings = { Alice: 'alice-second' };
    draft.characterBindingPlan = {
      status: 'ready',
      bindings: {
        Alice: { name: 'Alice', speakerId: 'alice-first', source: 'user_disambiguation' },
      },
      preallocatedCharacterIds: [],
    };
    const document = makeDocument();
    document.meta.characters = [
      { id: 'alice-first', name: 'Alice' },
      { id: 'alice-second', name: 'Alice' },
    ];
    let commitCalls = 0;
    await expect(new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    }).apply(draft, document)).rejects.toMatchObject({ code: 'binding-conflict' });
    expect(commitCalls).toBe(0);
  });

  it('refuses apply when the scene gained a character occupying a plan-preallocated id', async () => {
    const document = makeDocument();
    const plan = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice', 'Bob'],
    });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    const bobId = plan.bindings.Bob!.speakerId;

    const gained = {
      ...document,
      meta: {
        ...document.meta,
        characters: [...document.meta.characters!, { id: bobId, name: 'Eve' }],
      },
    };
    const draft = makeDraftWithStatements(['Alice', 'Bob'], [
      { speaker: 'Alice', text: '甲。', time: 10, durationSeconds: 1, gapSecondsToNext: 1 },
      { speaker: 'Bob', text: '乙。', time: 11, durationSeconds: 1, gapSecondsToNext: 1 },
    ]);
    draft.characterBindingPlan = plan;
    let commitCalls = 0;
    await expect(new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    }).apply(draft, gained)).rejects.toMatchObject({ code: 'binding-conflict' });
    expect(commitCalls).toBe(0);
  });

  it('refuses apply when a preallocated id would regenerate with a different suffix on the latest scene', async () => {
    const document = makeDocument();
    const firstPass = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice', 'Bob'],
    });
    expect(firstPass.status).toBe('ready');
    if (firstPass.status !== 'ready') return;
    const bobBaseId = firstPass.bindings.Bob!.speakerId;

    // At plan time the base hash was occupied by another character, so the plan
    // preallocated the suffixed id. The occupying character is gone by apply
    // time — regeneration now yields the base id, which is a silent re-bind.
    const occupiedScene = {
      ...document,
      meta: {
        ...document.meta,
        characters: [...document.meta.characters!, { id: bobBaseId, name: 'Eve' }],
      },
    };
    const plan = buildCharacterBindingPlan({
      document: occupiedScene,
      confirmedMainCharacters: ['Alice', 'Bob'],
    });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;
    expect(plan.bindings.Bob!.speakerId).toMatch(new RegExp(`^${bobBaseId}_`));

    const draft = makeDraftWithStatements(['Alice', 'Bob'], [
      { speaker: 'Alice', text: '甲。', time: 10, durationSeconds: 1, gapSecondsToNext: 1 },
      { speaker: 'Bob', text: '乙。', time: 11, durationSeconds: 1, gapSecondsToNext: 1 },
    ]);
    draft.characterBindingPlan = plan;
    let commitCalls = 0;
    await expect(new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    }).apply(draft, document)).rejects.toMatchObject({ code: 'binding-conflict' });
    expect(commitCalls).toBe(0);
  });

  it('applies an unchanged scene whose plan preallocated id regenerates identically', async () => {
    const document = makeDocument();
    const plan = buildCharacterBindingPlan({
      document,
      confirmedMainCharacters: ['Alice', 'Bob'],
    });
    expect(plan.status).toBe('ready');
    if (plan.status !== 'ready') return;

    const draft = makeDraftWithStatements(['Alice', 'Bob'], [
      { speaker: 'Alice', text: '甲。', time: 10, durationSeconds: 1, gapSecondsToNext: 1 },
      { speaker: 'Bob', text: '乙。', time: 11, durationSeconds: 1, gapSecondsToNext: 1 },
    ]);
    draft.characterBindingPlan = plan;
    const result = await new AiProseSceneApplicator({
      commitApplied: () => undefined,
    }).apply(draft, document);

    expect(result.receipt.characterBindings.Bob).toBe(plan.bindings.Bob!.speakerId);
  });

  it('duplicates an applied archive into a fresh active session that can re-apply', async () => {
    const draft = makeDraft();
    draft.characterBindingPlan = {
      status: 'ready',
      bindings: {
        Alice: { name: 'Alice', speakerId: 'character-alice', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    };
    let appliedDraft: AiProseDraftSession | null = null;
    const result = await new AiProseSceneApplicator({
      commitApplied: (_input) => {
        appliedDraft = _input.appliedDraft;
      },
    }).apply(draft, makeDocument());
    expect(result.appliedDraft.status).toBe('applied');

    const copy = duplicateAppliedDraft(result.appliedDraft, { sessionId: 'session-copy' });
    expect(copy.status).toBe('active');
    expect(copy.sessionId).toBe('session-copy');
    expect(copy.sceneId).toBe('scene-1');
    expect(copy.sourceText).toBe(result.appliedDraft.sourceText);
    expect(copy.appliedAt).toBeUndefined();
    expect(copy.receipt).toBeUndefined();
    expect(copy.characterBindingPlan).toEqual(draft.characterBindingPlan);
    expect(copy.preview).toEqual(result.appliedDraft.preview);

    // The copy can be applied again (idempotent against the original scene).
    let commitCalls = 0;
    const second = await new AiProseSceneApplicator({
      commitApplied: () => {
        commitCalls += 1;
      },
    }).apply(copy, makeDocument());
    expect(commitCalls).toBe(1);
    expect(second.appliedDraft.status).toBe('applied');
    expect(second.appliedDraft.sessionId).toBe('session-copy');
    void appliedDraft;
  });
});
