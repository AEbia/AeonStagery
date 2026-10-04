import { describe, expect, it } from 'vitest';
import {
  migrateDraft,
  AiProseDraftMigrationError,
} from '../services/ai-authoring/AiProseDraftMigration';

function baseV3Draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    sessionId: 'v3-session',
    sceneId: 'scene-1',
    sourceText: '正文',
    sourceRevision: 0,
    anchorMode: 'zero',
    anchorTime: 0,
    targetBatchSize: 4000,
    scriptReadingSpeed: 9,
    status: 'active',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:01:00.000Z',
    segmentation: {
      status: 'idle',
      planFingerprint: 'fp',
      targetSegmentCount: 1,
      candidates: [],
      boundaryIds: [],
      segments: [],
    },
    characterExtraction: { status: 'idle', suggestedNames: [] },
    confirmedMainCharacters: [],
    mainCharactersConfirmed: false,
    normalization: [],
    rhythm: [],
    preview: null,
    characterBindings: {},
    ...overrides,
  };
}

describe('AiProseDraftMigration', () => {
  it('migrates the official legacy schema without resetting successful stages', () => {
    const legacy = {
      schemaVersion: 0,
      sessionId: 'legacy-session',
      sceneId: 'scene-1',
      sourceText: '正文',
      anchorMode: 'playhead',
      anchorTime: 8.5,
      targetBatchSize: 4000,
      status: 'active',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:01:00.000Z',
      segmentation: {
        status: 'succeeded',
        targetSegmentCount: 1,
        candidates: [],
        boundaryIds: [],
        segments: [],
      },
      characterExtraction: {
        status: 'succeeded',
        suggestedNames: ['林夏'],
      },
      mainCharacters: ['林夏'],
      mainCharactersConfirmed: true,
      normalization: [{
        segmentIndex: 0,
        status: 'succeeded',
        statements: [{ speaker: '林夏', text: '你好。' }],
      }],
      rhythm: [{ segmentIndex: 0, status: 'succeeded', gapSeconds: [] }],
      preview: {
        statements: [],
        anchorTime: 8.5,
        durationSeconds: 0,
      },
    };

    const migrated = migrateDraft(legacy);

    expect(migrated).toMatchObject({
      schemaVersion: 3,
      sourceRevision: 0,
      scriptReadingSpeed: 9,
      confirmedMainCharacters: ['林夏'],
      mainCharactersConfirmed: true,
      characterBindings: {},
    });
    expect(migrated).not.toHaveProperty('characterBindingPlan');
    expect(migrated).not.toHaveProperty('enhancement');
    expect(migrated.segmentation.status).toBe('succeeded');
    expect(migrated.segmentation.planFingerprint).toBeTruthy();
    expect(migrated.characterExtraction.status).toBe('succeeded');
    expect(migrated.normalization[0].status).toBe('succeeded');
    expect(migrated.rhythm[0].status).toBe('succeeded');
    expect(migrated.preview).not.toBeNull();
  });

  it('reports a future schema without attempting a downgrade', () => {
    expect(() => migrateDraft({ schemaVersion: 99 })).toThrowError(
      expect.objectContaining({ code: 'future-schema' }),
    );
  });

  it('reports malformed current structure separately from version errors', () => {
    try {
      migrateDraft({ schemaVersion: 2, sessionId: 'session-1' });
      throw new Error('expected migration to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AiProseDraftMigrationError);
      expect(error).toMatchObject({ code: 'invalid-structure' });
    }
  });

  it('migrates v2 drafts to v3 without inventing a binding plan or enhancement state', () => {
    const v2 = {
      schemaVersion: 2,
      sessionId: 'v2-session',
      sceneId: 'scene-1',
      sourceText: '正文',
      sourceRevision: 0,
      anchorMode: 'zero',
      anchorTime: 0,
      targetBatchSize: 4000,
      scriptReadingSpeed: 9,
      status: 'active',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:01:00.000Z',
      segmentation: {
        status: 'succeeded',
        planFingerprint: 'fp',
        targetSegmentCount: 1,
        candidates: [],
        boundaryIds: [],
        segments: [],
      },
      characterExtraction: { status: 'succeeded', suggestedNames: ['林夏'] },
      confirmedMainCharacters: ['林夏'],
      mainCharactersConfirmed: true,
      normalization: [{
        segmentIndex: 0,
        status: 'succeeded',
        statements: [{ speaker: '林夏', text: '你好。' }],
      }],
      rhythm: [{ segmentIndex: 0, status: 'succeeded', gapSeconds: [] }],
      preview: { statements: [], anchorTime: 0, durationSeconds: 0 },
      characterBindings: { 林夏: 'char_1' },
    };

    const migrated = migrateDraft(v2);

    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.characterBindingPlan).toBeUndefined();
    expect(migrated.enhancement).toBeUndefined();
    expect(migrated.characterBindings).toEqual({ 林夏: 'char_1' });
    expect(migrated.normalization[0]?.status).toBe('succeeded');
  });

  it('still migrates the older v1 schema without losing successful stages', () => {
    const v1 = {
      schemaVersion: 1,
      sessionId: 'v1-session',
      sceneId: 'scene-1',
      sourceText: '正文',
      sourceRevision: 0,
      anchorMode: 'zero',
      anchorTime: 0,
      targetBatchSize: 4000,
      status: 'active',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:01:00.000Z',
      segmentation: {
        status: 'succeeded',
        targetSegmentCount: 1,
        candidates: [],
        boundaryIds: [],
        segments: [],
      },
      characterExtraction: { status: 'succeeded', suggestedNames: ['林夏'] },
      confirmedMainCharacters: ['林夏'],
      mainCharactersConfirmed: true,
      normalization: [{
        segmentIndex: 0,
        status: 'succeeded',
        statements: [{ speaker: '林夏', text: '你好。' }],
      }],
      rhythm: [{ segmentIndex: 0, status: 'succeeded', gapSeconds: [] }],
      preview: { statements: [], anchorTime: 0, durationSeconds: 0 },
      characterBindings: {},
    };

    const migrated = migrateDraft(v1);

    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.scriptReadingSpeed).toBe(9);
    expect(migrated.segmentation.planFingerprint).toBeTruthy();
    expect(migrated.normalization[0]?.status).toBe('succeeded');
    expect(migrated.characterBindingPlan).toBeUndefined();
    expect(migrated.enhancement).toBeUndefined();
  });

  it('loads a v3 draft with a persisted binding plan and enhancement state', () => {
    const v3 = {
      schemaVersion: 3,
      sessionId: 'v3-session',
      sceneId: 'scene-1',
      sourceText: '正文',
      sourceRevision: 0,
      anchorMode: 'zero',
      anchorTime: 0,
      targetBatchSize: 4000,
      scriptReadingSpeed: 9,
      status: 'active',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:01:00.000Z',
      segmentation: {
        status: 'succeeded',
        planFingerprint: 'fp',
        targetSegmentCount: 1,
        candidates: [],
        boundaryIds: [],
        segments: [],
      },
      characterExtraction: { status: 'succeeded', suggestedNames: ['素世'] },
      confirmedMainCharacters: ['素世'],
      mainCharactersConfirmed: true,
      normalization: [],
      rhythm: [],
      preview: null,
      characterBindings: {},
      characterBindingPlan: {
        status: 'ready',
        bindings: {
          素世: { name: '素世', speakerId: 'soyo', source: 'existing_unique' },
        },
        preallocatedCharacterIds: [],
      },
      enhancement: {
        version: 1,
        baseFingerprint: 'fp-abc',
        performance: {
          stage: 'performance',
          status: 'succeeded',
          units: [{
            key: 'seg-0',
            stage: 'performance',
            status: 'succeeded',
            attemptCount: 1,
            policyVersion: 'performance-stage-policy/v1',
            processorVersion: 'performance-processor/v1',
            inputFingerprint: 'unit-fp',
            patch: { version: 1, operations: [] },
            modelName: 'gpt-4o-mini',
            lineViewContextChars: 12000,
          }],
        },
      },
    };

    const migrated = migrateDraft(v3);

    expect(migrated.characterBindingPlan).toMatchObject({
      status: 'ready',
      bindings: { 素世: { name: '素世', speakerId: 'soyo', source: 'existing_unique' } },
    });
    expect(migrated.enhancement?.performance?.units[0]).toMatchObject({
      key: 'seg-0',
      status: 'succeeded',
      patch: { version: 1, operations: [] },
      lineViewContextChars: 12000,
    });
  });

  it('rejects malformed binding plans while tolerating unsupported enhancement versions', () => {
    const base = (overrides: Record<string, unknown>) => ({
      schemaVersion: 3,
      sessionId: 'v3-session',
      sceneId: 'scene-1',
      sourceText: '正文',
      sourceRevision: 0,
      anchorMode: 'zero',
      anchorTime: 0,
      targetBatchSize: 4000,
      scriptReadingSpeed: 9,
      status: 'active',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:01:00.000Z',
      segmentation: {
        status: 'idle',
        planFingerprint: '',
        targetSegmentCount: 1,
        candidates: [],
        boundaryIds: [],
        segments: [],
      },
      characterExtraction: { status: 'idle', suggestedNames: [] },
      confirmedMainCharacters: [],
      mainCharactersConfirmed: false,
      normalization: [],
      rhythm: [],
      preview: null,
      characterBindings: {},
      ...overrides,
    });

    expect(() => migrateDraft(base({
      characterBindingPlan: {
        status: 'ready',
        bindings: {},
        ambiguous: [{ name: '素世', candidateIds: ['a'] }],
        preallocatedCharacterIds: [],
      },
    }))).toThrowError(expect.objectContaining({ code: 'invalid-structure' }));

    expect(() => migrateDraft(base({
      characterBindingPlan: {
        status: 'ambiguous',
        bindings: {},
        ambiguous: [],
        preallocatedCharacterIds: [],
      },
    }))).toThrowError(expect.objectContaining({ code: 'invalid-structure' }));
  });

  it('loads a draft whose enhancement state version is unsupported by dropping the enhancement', () => {
    const migrated = migrateDraft(baseV3Draft({
      enhancement: { version: 99, baseFingerprint: 'fp-abc' },
    }));

    expect(migrated.enhancement).toBeUndefined();
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.sourceText).toBe('正文');
  });

  it('drops a malformed performance stage checkpoint while keeping the cinematic stage', () => {
    const migrated = migrateDraft(baseV3Draft({
      enhancement: {
        version: 1,
        baseFingerprint: 'fp-abc',
        performance: { stage: 'performance', status: 'bogus-status', units: 'nope' },
        cinematic: {
          stage: 'cinematic',
          status: 'succeeded',
          units: [{
            key: 'seg-0',
            stage: 'cinematic',
            status: 'succeeded',
            attemptCount: 1,
            policyVersion: 'cinematic-stage-policy/v2',
            processorVersion: 'cinematic-processor/v1',
            patch: { version: 1, operations: [] },
          }],
        },
      },
    }));

    expect(migrated.enhancement?.performance).toBeUndefined();
    expect(migrated.enhancement?.cinematic?.units[0]).toMatchObject({
      key: 'seg-0',
      status: 'succeeded',
    });
  });

  it('still refuses to load a draft whose root schema version is unknown', () => {
    expect(() => migrateDraft(baseV3Draft({ schemaVersion: 4 }))).toThrowError(
      expect.objectContaining({ code: 'future-schema' }),
    );
  });

  it('loads a draft whose enhancement unit key is a technical split containing a #', () => {
    const migrated = migrateDraft(baseV3Draft({
      enhancement: {
        version: 1,
        baseFingerprint: 'fp-abc',
        performance: {
          stage: 'performance',
          status: 'succeeded',
          units: [{
            key: 'seg-0#t1',
            stage: 'performance',
            status: 'succeeded',
            attemptCount: 1,
            policyVersion: 'performance-stage-policy/v1',
            processorVersion: 'performance-processor/v1',
            inputFingerprint: 'unit-fp',
            patch: { version: 1, operations: [] },
          }],
        },
      },
    }));

    expect(migrated.enhancement?.performance?.units[0]?.key).toBe('seg-0#t1');
    expect(migrated.enhancement?.performance?.units[0]?.status).toBe('succeeded');
  });

  it('still rejects session and scene ids containing a #', () => {
    expect(() => migrateDraft(baseV3Draft({ sessionId: 'session#1' }))).toThrowError(
      expect.objectContaining({ code: 'invalid-structure' }),
    );
    expect(() => migrateDraft(baseV3Draft({ sceneId: 'scene#1' }))).toThrowError(
      expect.objectContaining({ code: 'invalid-structure' }),
    );
  });

  it('loads a draft whose enhancement unit patch fails to parse and invalidates only that unit', () => {
    const migrated = migrateDraft(baseV3Draft({
      enhancement: {
        version: 1,
        baseFingerprint: 'fp-abc',
        performance: {
          stage: 'performance',
          status: 'succeeded',
          units: [
            {
              key: 'seg-0',
              stage: 'performance',
              status: 'succeeded',
              attemptCount: 1,
              policyVersion: 'performance-stage-policy/v1',
              processorVersion: 'performance-processor/v1',
              patch: { version: 1, operations: [{ kind: 'unknownOperation', line: 1 }] },
            },
            {
              key: 'seg-1',
              stage: 'performance',
              status: 'succeeded',
              attemptCount: 1,
              policyVersion: 'performance-stage-policy/v1',
              processorVersion: 'performance-processor/v1',
              patch: { version: 1, operations: [] },
            },
          ],
        },
      },
    }));

    const units = migrated.enhancement?.performance?.units ?? [];
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      key: 'seg-0',
      status: 'retryableFailed',
      patch: undefined,
    });
    expect(units[0]?.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid_checkpoint' }),
    );
    expect(units[1]).toMatchObject({ key: 'seg-1', status: 'succeeded' });
  });

  it('falls back to an invalid-N key when a stored unit key itself is unsafe', () => {
    const migrated = migrateDraft(baseV3Draft({
      enhancement: {
        version: 1,
        baseFingerprint: 'fp-abc',
        performance: {
          stage: 'performance',
          status: 'succeeded',
          units: [
            { key: '../seg-0', stage: 'performance', status: 'succeeded' },
            {
              key: 'seg-1',
              stage: 'performance',
              status: 'succeeded',
              attemptCount: 1,
              policyVersion: 'p',
              processorVersion: 'r',
            },
          ],
        },
      },
    }));

    const units = migrated.enhancement?.performance?.units ?? [];
    expect(units[0]).toMatchObject({
      key: 'invalid-0',
      status: 'retryableFailed',
      patch: undefined,
    });
    expect(units[0]?.diagnostics?.[0]?.code).toBe('invalid_checkpoint');
    expect(units[1]).toMatchObject({ key: 'seg-1', status: 'succeeded' });
  });
});
