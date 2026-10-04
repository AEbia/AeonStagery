import { describe, expect, it } from 'vitest';
import {
  applyDraft,
  clearEnhancementState,
  confirmMainCharacters,
  createDraft,
  replaceCharacterExtraction,
  replaceEnhancementState,
  replaceNormalization,
  replacePreview,
  replaceRhythm,
  replaceSegmentation,
  setCharacterBinding,
  setCharacterBindingPlan,
  updateNormalizationTask,
  updateRhythmTask,
  updateMainCharacters,
  updateSourceText,
  type DraftSession,
} from '../services/ai-authoring/AiProseDraftSession';
import type { SemanticAuthorReceipt } from '../api/types/authoring';
import type {
  AiProseCharacterExtractionState,
  AiProseCharacterBindingPlanV1,
  AiProseNormalizationTask,
  AiProsePreview,
  AiProseRhythmTask,
  AiProseSegmentationState,
} from '../api/types/ai-prose-authoring';
import type { AiProseEnhancementStateV1 } from '../api/types/ai-prose-enhancement';

describe('AiProseDraftSession', () => {
  it('creates a zero-anchored draft without sampling a playhead', () => {
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'session-1',
      sourceText: '她走进房间。',
      anchorMode: 'zero',
      playheadTime: undefined,
      now: '2026-08-03T00:00:00.000Z',
    });

    expect(draft).toMatchObject({
      schemaVersion: 3,
      sceneId: 'scene-1',
      sessionId: 'session-1',
      sourceText: '她走进房间。',
      sourceRevision: 0,
      anchorMode: 'zero',
      anchorTime: 0,
      status: 'active',
      mainCharactersConfirmed: false,
      preview: null,
    });
  });

  it('captures a valid playhead once at creation', () => {
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'session-2',
      sourceText: '正文',
      anchorMode: 'playhead',
      playheadTime: 12.5,
      now: '2026-08-03T00:00:00.000Z',
    });

    expect(draft.anchorTime).toBe(12.5);
  });

  it.each([
    ['missing', undefined],
    ['negative', -0.1],
    ['infinite', Number.POSITIVE_INFINITY],
    ['nan', Number.NaN],
  ])('rejects a %s playhead for playhead anchoring', (_label, playheadTime) => {
    expect(() => createDraft({
      sceneId: 'scene-1',
      sessionId: 'session-3',
      sourceText: '正文',
      anchorMode: 'playhead',
      playheadTime,
    })).toThrow(/playheadTime/);
  });

  it('increments the source revision and invalidates source-derived stages', () => {
    const segmentation: AiProseSegmentationState = {
      status: 'succeeded',
      planFingerprint: 'plan-1',
      targetSegmentCount: 1,
      candidates: [],
      boundaryIds: [],
      segments: [],
    };
    const extraction: AiProseCharacterExtractionState = {
      status: 'succeeded',
      suggestedNames: ['林夏'],
    };
    const normalization: AiProseNormalizationTask[] = [{
      segmentIndex: 0,
      status: 'succeeded',
      statements: [{ speaker: '林夏', text: '你好。' }],
    }];
    const rhythm: AiProseRhythmTask[] = [{
      segmentIndex: 0,
      status: 'succeeded',
      gapSeconds: [],
    }];
    const preview: AiProsePreview = {
      statements: [{
        speaker: '林夏',
        text: '你好。',
        segmentIndex: 0,
        statementIndex: 0,
        time: 0,
        durationSeconds: 0.9,
        gapSecondsToNext: 0,
      }],
      anchorTime: 0,
      durationSeconds: 0.9,
    };
    let draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'source-change',
      sourceText: '旧正文',
      anchorMode: 'zero',
    });
    draft = replaceSegmentation(draft, segmentation);
    draft = replaceCharacterExtraction(draft, extraction);
    draft = confirmMainCharacters(draft, ['林夏']);
    draft = replaceNormalization(draft, normalization);
    draft = replaceRhythm(draft, rhythm);
    draft = replacePreview(draft, preview);

    const updated = updateSourceText(draft, '新正文', { now: '2026-08-03T00:01:00.000Z' });

    expect(updated.sourceText).toBe('新正文');
    expect(updated.sourceRevision).toBe(1);
    expect(updated.segmentation).toMatchObject({
      status: 'idle',
      candidates: [],
      boundaryIds: [],
      segments: [],
    });
    expect(updated.characterExtraction).toEqual({ status: 'idle', suggestedNames: [] });
    expect(updated.confirmedMainCharacters).toEqual([]);
    expect(updated.mainCharactersConfirmed).toBe(false);
    expect(updated.normalization).toEqual([]);
    expect(updated.rhythm).toEqual([]);
    expect(updated.preview).toBeNull();
    expect(updated.updatedAt).toBe('2026-08-03T00:01:00.000Z');
  });

  it('preserves segmentation and extraction when confirmed names change', () => {
    const segmentation: AiProseSegmentationState = {
      status: 'succeeded',
      planFingerprint: 'plan-2',
      targetSegmentCount: 2,
      candidates: [{ id: 'L0001', kind: 'line', lineNumber: 1, position: 3 }],
      boundaryIds: ['L0001'],
      segments: [{ index: 0, startOffset: 0, endOffset: 3, sourceText: '正文' }],
    };
    const extraction: AiProseCharacterExtractionState = {
      status: 'succeeded',
      suggestedNames: ['林夏'],
    };
    let draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'name-change',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    draft = replaceSegmentation(draft, segmentation);
    draft = replaceCharacterExtraction(draft, extraction);
    draft = confirmMainCharacters(draft, ['林夏']);
    draft = replaceNormalization(draft, [{
      segmentIndex: 0,
      status: 'succeeded',
      statements: [{ speaker: '林夏', text: '你好。' }],
    }]);
    draft = replaceRhythm(draft, [{ segmentIndex: 0, status: 'succeeded', gapSeconds: [] }]);
    draft = replacePreview(draft, {
      statements: [],
      anchorTime: 0,
      durationSeconds: 0,
    });

    const updated = updateMainCharacters(draft, ['周衡']);

    expect(updated.sourceText).toBe(draft.sourceText);
    expect(updated.segmentation).toEqual(segmentation);
    expect(updated.characterExtraction).toEqual(extraction);
    expect(updated.confirmedMainCharacters).toEqual(['周衡']);
    expect(updated.mainCharactersConfirmed).toBe(false);
    expect(updated.normalization).toEqual([]);
    expect(updated.rhythm).toEqual([]);
    expect(updated.preview).toBeNull();
  });

  it('archives an active draft as applied and rejects every later mutation', () => {
    const receipt: SemanticAuthorReceipt = {
      version: 3,
      correlationId: 'receipt-1',
      intentType: 'insert-script-segment',
      origin: 'ai-script-panel',
      historyDescriptor: {
        key: 'ai.prose.applied',
        args: {},
        fallbackLabel: 'AI prose applied',
      },
      warnings: [],
      resolvedScope: { kind: 'none' },
      createdStatementIds: ['statement-1'],
      updatedStatementIds: [],
      deletedStatementIds: [],
      createdCompanionLocators: [],
      updatedCompanionLocators: [],
      deletedCompanionLocators: [],
      createdMarkerIds: [],
      deletedMarkerIds: [],
      createdMarkers: [],
      deletedMarkers: [],
      sideEffects: [],
    };
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'applied',
      sourceText: '正文',
      anchorMode: 'zero',
    });

    const applied = applyDraft(draft, receipt, {
      appliedAt: '2026-08-03T00:02:00.000Z',
      now: '2026-08-03T00:02:00.000Z',
    });

    expect(applied).toMatchObject({
      status: 'applied',
      appliedAt: '2026-08-03T00:02:00.000Z',
      receipt,
    });
    expect(() => updateSourceText(applied, '不能修改')).toThrow(/read-only/);
    expect(() => updateMainCharacters(applied, ['林夏'])).toThrow(/read-only/);
    expect(() => replacePreview(applied, null)).toThrow(/read-only/);
    expect(() => applyDraft(applied, receipt)).toThrow(/read-only/);
  });

  it('updates individual stage tasks and character bindings as checkpoints', () => {
    let draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'checkpoint',
      sourceText: '正文',
      anchorMode: 'zero',
    });

    draft = updateNormalizationTask(draft, {
      segmentIndex: 1,
      status: 'succeeded',
      statements: [{ speaker: '林夏', text: '后段' }],
    });
    draft = updateNormalizationTask(draft, {
      segmentIndex: 0,
      status: 'succeeded',
      statements: [{ speaker: '', text: '前段' }],
    });
    draft = updateRhythmTask(draft, {
      segmentIndex: 1,
      status: 'succeeded',
      gapSeconds: [0.5],
    });
    draft = setCharacterBinding(draft, '林夏', 'character-1');

    expect(draft.normalization.map((task) => task.segmentIndex)).toEqual([0, 1]);
    expect(draft.normalization[1].statements[0].text).toBe('后段');
    expect(draft.rhythm).toEqual([{ segmentIndex: 1, status: 'succeeded', gapSeconds: [0.5] }]);
    expect(draft.characterBindings).toEqual({ 林夏: 'character-1' });
  });

  it('invalidates every downstream stage when an upstream checkpoint changes', () => {
    const populated = (): DraftSession => {
      let draft = createDraft({
        sceneId: 'scene-1',
        sessionId: 'invalidation',
        sourceText: '正文',
        anchorMode: 'zero',
      });
      draft = replaceSegmentation(draft, {
        status: 'succeeded',
        planFingerprint: 'test-plan',
        targetSegmentCount: 1,
        candidates: [],
        boundaryIds: [],
        segments: [],
      });
      draft = replaceCharacterExtraction(draft, {
        status: 'succeeded',
        suggestedNames: ['林夏'],
      });
      draft = confirmMainCharacters(draft, ['林夏']);
      draft = replaceNormalization(draft, [{
        segmentIndex: 0,
        status: 'succeeded',
        statements: [{ speaker: '林夏', text: '你好。' }],
      }]);
      draft = replaceRhythm(draft, [{ segmentIndex: 0, status: 'succeeded', gapSeconds: [] }]);
      return replacePreview(draft, {
        statements: [{
          speaker: '林夏',
          text: '你好。',
          segmentIndex: 0,
          statementIndex: 0,
          time: 0,
          durationSeconds: 0.9,
          gapSecondsToNext: 0,
        }],
        anchorTime: 0,
        durationSeconds: 0.9,
      });
    };

    const afterSegmentation = replaceSegmentation(populated(), {
      status: 'succeeded',
      planFingerprint: 'changed-plan',
      targetSegmentCount: 2,
      candidates: [],
      boundaryIds: [],
      segments: [],
    });
    expect(afterSegmentation.normalization).toEqual([]);
    expect(afterSegmentation.rhythm).toEqual([]);
    expect(afterSegmentation.preview).toBeNull();

    const afterExtraction = replaceCharacterExtraction(populated(), {
      status: 'succeeded',
      suggestedNames: ['周衡'],
    });
    expect(afterExtraction.normalization).toEqual([]);
    expect(afterExtraction.rhythm).toEqual([]);
    expect(afterExtraction.preview).toBeNull();

    const afterNormalization = updateNormalizationTask(populated(), {
      segmentIndex: 0,
      status: 'succeeded',
      statements: [{ speaker: '林夏', text: '更新。' }],
    });
    expect(afterNormalization.rhythm).toEqual([]);
    expect(afterNormalization.preview).toBeNull();

    const afterRhythm = updateRhythmTask(populated(), {
      segmentIndex: 0,
      status: 'succeeded',
      gapSeconds: [],
    });
    expect(afterRhythm.preview).toBeNull();
  });

  it('persists a character binding plan and keeps it fresh on user disambiguation', () => {
    let draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'plan',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    draft = confirmMainCharacters(draft, ['素世']);

    const readyPlan: AiProseCharacterBindingPlanV1 = {
      status: 'ready',
      bindings: {
        素世: { name: '素世', speakerId: 'soyo', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    };
    draft = setCharacterBindingPlan(draft, readyPlan);
    expect(draft.characterBindingPlan).toEqual(readyPlan);

    const ambiguousPlan: AiProseCharacterBindingPlanV1 = {
      status: 'ambiguous',
      bindings: {},
      ambiguous: [{ name: '素世', candidateIds: ['soyo', 'soyo2'] }],
      preallocatedCharacterIds: [],
    };
    draft = setCharacterBindingPlan(draft, ambiguousPlan);
    expect(draft.characterBindingPlan).toMatchObject({ status: 'ambiguous' });

    // User picks one candidate; the plan is replaced by the resolved plan.
    draft = setCharacterBinding(draft, '素世', 'soyo');
    draft = setCharacterBindingPlan(draft, readyPlan);
    expect(draft.characterBindingPlan).toEqual(readyPlan);
    expect(draft.characterBindings).toEqual({ 素世: 'soyo' });
  });

  it('clears the persisted plan and enhancement state when source or characters change', () => {
    let draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'clears',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    draft = confirmMainCharacters(draft, ['素世']);
    draft = setCharacterBindingPlan(draft, {
      status: 'ready',
      bindings: {
        素世: { name: '素世', speakerId: 'soyo', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    });
    draft = replaceEnhancementState(draft, {
      version: 1,
      baseFingerprint: 'fp',
    });
    expect(draft.enhancement).toBeDefined();

    const afterSource = updateSourceText(draft, '新正文');
    expect(afterSource.characterBindingPlan).toBeUndefined();
    expect(afterSource.enhancement).toBeUndefined();

    draft = updateSourceText(draft, '新正文'); // restore baseline without plan
    draft = confirmMainCharacters(draft, ['素世']);
    draft = setCharacterBindingPlan(draft, {
      status: 'ready',
      bindings: {
        素世: { name: '素世', speakerId: 'soyo', source: 'existing_unique' },
      },
      preallocatedCharacterIds: [],
    });
    draft = replaceEnhancementState(draft, {
      version: 1,
      baseFingerprint: 'fp',
    });

    const afterCharacters = updateMainCharacters(draft, ['素世', '灯']);
    expect(afterCharacters.characterBindingPlan).toBeUndefined();
    expect(afterCharacters.enhancement).toBeUndefined();
  });

  it('stores enhancement checkpoint state round-trip and clears it explicitly', () => {
    let draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'enhance',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    const state: AiProseEnhancementStateV1 = {
      version: 1,
      baseFingerprint: 'fp-1',
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
          usage: { inputTokens: 100, outputTokens: 50 },
          modelName: 'gpt-4o-mini',
        }],
      },
    };
    draft = replaceEnhancementState(draft, state);
    expect(draft.enhancement).toEqual(state);
    expect(JSON.parse(JSON.stringify(draft.enhancement))).toEqual(state);

    draft = clearEnhancementState(draft);
    expect(draft.enhancement).toBeUndefined();

    draft = replaceSegmentation(draft, {
      status: 'succeeded',
      planFingerprint: 'new-plan',
      targetSegmentCount: 1,
      candidates: [],
      boundaryIds: [],
      segments: [],
    });
    expect(draft.enhancement).toBeUndefined();
  });

  it('rejects invalid plan and enhancement inputs', () => {
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'invalid',
      sourceText: '正文',
      anchorMode: 'zero',
    });
    expect(() => setCharacterBindingPlan(draft, { status: 'bogus' } as never)).toThrow(/invalid/);
    expect(() => replaceEnhancementState(draft, { version: 1 } as never)).toThrow(/invalid/);
    expect(() => setCharacterBinding(draft, '', 'soyo')).toThrow(/non-empty/);
  });
});
