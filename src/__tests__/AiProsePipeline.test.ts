import { describe, expect, it } from 'vitest';
import { AiProseGlobalConfiguration } from '../services/ai-authoring/AiProseGlobalConfiguration';
import type { AiProseLlmRequest, AiProseLlmTransport } from '../services/ai-authoring/AiProseContracts';
import { AiProseLlmService } from '../services/ai-authoring/AiProseLlmService';
import {
  AiProsePipeline,
  createAiProseDraftPersistenceCheckpoint,
} from '../services/ai-authoring/AiProsePipeline';
import { createDraft } from '../services/ai-authoring/AiProseDraftSession';

function createConfiguration(maxConcurrentAiRequests = 2): AiProseGlobalConfiguration {
  return new AiProseGlobalConfiguration({
    provider: {
      endpoint: 'https://ai.example.test/v1',
      defaultModel: 'default-model',
      jsonOutputSupported: true,
    },
    request: {
      targetBatchSize: 4,
      maxConcurrentAiRequests,
    },
  });
}

describe('AiProsePipeline', () => {
  it('starts segmentation and character extraction in parallel and slices locally', async () => {
    const requests: AiProseLlmRequest[] = [];
    const pending: Array<(response: { content: string }) => void> = [];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        return new Promise((resolve) => pending.push(resolve));
      },
    };
    const service = new AiProseLlmService(createConfiguration(), transport);
    const pipeline = new AiProsePipeline(service);

    const preparedPromise = pipeline.prepare('第一行。\n第二行。');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests.map((request) => request.stage).sort()).toEqual([
      'characterExtraction',
      'segmentation',
    ]);

    const segmentation = pending[requests.findIndex((request) => request.stage === 'segmentation')];
    const characters = pending[requests.findIndex((request) => request.stage === 'characterExtraction')];
    segmentation({ content: JSON.stringify({ boundaryIds: ['L0001'] }) });
    characters({ content: JSON.stringify({ mainCharacters: ['林夏', '周衡'] }) });

    const prepared = await preparedPromise;

    expect(prepared.segments.map((segment) => segment.sourceText)).toEqual([
      '第一行。\n',
      '第二行。',
    ]);
    expect(prepared.suggestedMainCharacters).toEqual(['林夏', '周衡']);
    expect(prepared).not.toHaveProperty('model');
    expect(prepared).not.toHaveProperty('config');
  });

  it('normalizes confirmed segments with bounded shared concurrency and stable ordering', async () => {
    const requests: AiProseLlmRequest[] = [];
    let activeNormalizations = 0;
    let maxActiveNormalizations = 0;
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: ['L0001', 'L0002'] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: ['林夏'] }) };
        }

        const match = request.userPrompt.match(/故事段 (\d+)/u);
        const segmentIndex = Number(match?.[1] ?? 0) - 1;
        activeNormalizations += 1;
        maxActiveNormalizations = Math.max(maxActiveNormalizations, activeNormalizations);
        await new Promise((resolve) => setTimeout(resolve, [30, 0, 10][segmentIndex] ?? 0));
        activeNormalizations -= 1;
        return {
          content: JSON.stringify({
            statements: [{ speaker: '林夏', text: `${String.fromCharCode(65 + segmentIndex)}段。` }],
          }),
        };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(
      createConfiguration(2),
      transport,
    ));
    const prepared = await pipeline.prepare('A段。\nB段。\nC段。', { targetBatchSize: 4 });

    const run = await pipeline.normalize(prepared, {
      confirmedMainCharacters: ['林夏'],
      mainCharactersConfirmed: true,
    });

    expect(run.status).toBe('succeeded');
    expect(run.tasks.map((task) => task.segmentIndex)).toEqual([0, 1, 2]);
    expect(run.tasks.map((task) => task.statements[0]?.text)).toEqual([
      'A段。',
      'B段。',
      'C段。',
    ]);
    expect(maxActiveNormalizations).toBe(2);
    const normalizationRequests = requests.filter((request) => request.stage === 'normalization');
    expect(normalizationRequests).toHaveLength(3);
    expect(normalizationRequests[0].userPrompt).not.toContain('B段。');
    expect(normalizationRequests[0].userPrompt).not.toContain('C段。');
    expect(normalizationRequests[0].userPrompt).toContain('林夏');
  });

  it('does not start normalization before the confirmed-name threshold is met', async () => {
    const requests: AiProseLlmRequest[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: [] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: [] }) };
        }
        return { content: JSON.stringify({ statements: [{ speaker: '', text: '旁白。' }] }) };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(createConfiguration(), transport));
    const prepared = await pipeline.prepare('一段。', { targetBatchSize: 100 });

    await expect(pipeline.normalize(prepared, {
      confirmedMainCharacters: [],
      mainCharactersConfirmed: false,
    })).rejects.toMatchObject({ code: 'main-characters-not-confirmed' });
    expect(requests.filter((request) => request.stage === 'normalization')).toHaveLength(0);
  });

  it('allows an explicitly confirmed empty character list for narration-only normalization', async () => {
    const requests: AiProseLlmRequest[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: [] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: [] }) };
        }
        return { content: JSON.stringify({ statements: [{ speaker: '', text: '纯旁白。' }] }) };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(createConfiguration(), transport));
    const prepared = await pipeline.prepare('纯旁白。', { targetBatchSize: 100 });

    const run = await pipeline.normalize(prepared, {
      confirmedMainCharacters: [],
      mainCharactersConfirmed: true,
    });

    expect(run.status).toBe('succeeded');
    expect(run.confirmedMainCharacters).toEqual([]);
    expect(run.tasks[0].statements).toEqual([{ speaker: '', text: '纯旁白。' }]);
    expect(requests.filter((request) => request.stage === 'normalization')).toHaveLength(1);
  });

  it('retries only the failed segment and preserves successful normalization tasks', async () => {
    const requests: AiProseLlmRequest[] = [];
    let failedSegmentAttempts = 0;
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: ['L0001', 'L0002'] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: ['林夏'] }) };
        }
        const match = request.userPrompt.match(/故事段 (\d+)/u);
        const segmentIndex = Number(match?.[1] ?? 0) - 1;
        if (segmentIndex === 1 && failedSegmentAttempts < 2) {
          failedSegmentAttempts += 1;
          return { content: 'invalid' };
        }
        return {
          content: JSON.stringify({
            statements: [{ speaker: '林夏', text: `${String.fromCharCode(65 + segmentIndex)}段。` }],
          }),
        };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(createConfiguration(), transport));
    const prepared = await pipeline.prepare('A段。\nB段。\nC段。', { targetBatchSize: 4 });
    const initial = await pipeline.normalize(prepared, ['林夏']);

    expect(initial.tasks.map((task) => task.status)).toEqual([
      'succeeded',
      'failed',
      'succeeded',
    ]);
    const successfulBeforeRetry = [initial.tasks[0], initial.tasks[2]];

    const retried = await pipeline.retrySegment(prepared, initial, 1);

    expect(retried.status).toBe('succeeded');
    expect(retried.tasks.map((task) => task.segmentIndex)).toEqual([0, 1, 2]);
    expect(retried.tasks.map((task) => task.statements[0]?.text)).toEqual([
      'A段。',
      'B段。',
      'C段。',
    ]);
    expect(retried.tasks[0]).toEqual(successfulBeforeRetry[0]);
    expect(retried.tasks[2]).toEqual(successfulBeforeRetry[1]);
    const retryRequests = requests.filter((request) => request.stage === 'normalization').slice(-1);
    expect(retryRequests).toHaveLength(1);
    expect(retryRequests[0].userPrompt).toContain('B段。');
    expect(retryRequests[0].userPrompt).not.toContain('A段。');
    expect(retryRequests[0].userPrompt).not.toContain('C段。');
  });

  it('restores successful prepare and normalization checkpoints without re-requesting them', async () => {
    const requests: AiProseLlmRequest[] = [];
    let shouldFailSegment = true;
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: ['L0001', 'L0002'] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: ['林夏'] }) };
        }
        const match = request.userPrompt.match(/故事段 (\d+)/u);
        const segmentIndex = Number(match?.[1] ?? 0) - 1;
        if (request.stage === 'normalization' && segmentIndex === 1 && shouldFailSegment) {
          return { content: 'invalid normalization' };
        }
        if (request.stage === 'normalization') {
          return {
            content: JSON.stringify({
              statements: [{ speaker: '林夏', text: `${segmentIndex}段。` }],
            }),
          };
        }
        return { content: JSON.stringify({ gapSeconds: [] }) };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(createConfiguration(), transport));
    const sourceText = 'A段。\nB段。\nC段。';
    const prepared = await pipeline.prepare(sourceText, { targetBatchSize: 4, sourceRevision: 2 });
    const afterPrepare = requests.length;
    const firstRun = await pipeline.normalize(prepared, ['林夏']);
    const afterFirstRun = requests.length;

    expect(firstRun.tasks.map((task) => task.status)).toEqual(['succeeded', 'failed', 'succeeded']);
    shouldFailSegment = false;
    const restoredPrepared = await pipeline.prepare(sourceText, {
      targetBatchSize: 4,
      sourceRevision: 2,
      existingPrepared: prepared,
    });
    expect(requests.length).toBe(afterFirstRun);
    const restoredRun = await pipeline.normalize(restoredPrepared, ['林夏'], {
      existing: firstRun,
    });

    expect(requests.length).toBe(afterFirstRun + 1);
    expect(restoredRun.tasks.map((task) => task.statements[0]?.text)).toEqual([
      '0段。',
      '1段。',
      '2段。',
    ]);
    expect(restoredRun.tasks[0]).toEqual(firstRun.tasks[0]);
    expect(restoredRun.tasks[2]).toEqual(firstRun.tasks[2]);
    expect(requests.slice(afterPrepare, afterFirstRun)
      .filter((request) => request.stage === 'normalization')).toHaveLength(4);
  });

  it('does not reuse normalization tasks when a changed batch size produces a different plan', async () => {
    const requests: AiProseLlmRequest[] = [];
    let segmentationCalls = 0;
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          segmentationCalls += 1;
          return {
            content: JSON.stringify({
              boundaryIds: segmentationCalls === 1 ? ['L0001', 'L0002'] : [],
            }),
          };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: ['林夏'] }) };
        }
        return { content: JSON.stringify({ statements: [{ speaker: '林夏', text: '当前段。' }] }) };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(createConfiguration(), transport));
    const sourceText = 'A段。\nB段。\nC段。';
    const firstPrepared = await pipeline.prepare(sourceText, { targetBatchSize: 4 });
    const firstRun = await pipeline.normalize(firstPrepared, ['林夏']);
    const beforeChangedPlan = requests.filter((request) => request.stage === 'normalization').length;

    const changedPrepared = await pipeline.prepare(sourceText, {
      targetBatchSize: 100,
      existingPrepared: firstPrepared,
    });
    const changedRun = await pipeline.normalize(changedPrepared, ['林夏'], { existing: firstRun });

    expect(changedPrepared.segments).toHaveLength(1);
    expect(requests.filter((request) => request.stage === 'normalization').length)
      .toBe(beforeChangedPlan + changedPrepared.segments.length);
    expect(changedRun.tasks).toHaveLength(changedPrepared.segments.length);
  });

  it('does not reuse normalization tasks when the selected boundary plan changes', async () => {
    const requests: AiProseLlmRequest[] = [];
    let segmentationCalls = 0;
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          segmentationCalls += 1;
          return {
            content: JSON.stringify({
              boundaryIds: segmentationCalls === 1 ? ['L0001', 'L0002'] : ['L0001'],
            }),
          };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: ['林夏'] }) };
        }
        return { content: JSON.stringify({ statements: [{ speaker: '林夏', text: '重新处理。' }] }) };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(createConfiguration(), transport));
    const sourceText = 'A段。\nB段。\nC段。';
    const firstPrepared = await pipeline.prepare(sourceText, { targetBatchSize: 4 });
    const firstRun = await pipeline.normalize(firstPrepared, ['林夏']);
    const beforeChangedPlan = requests.filter((request) => request.stage === 'normalization').length;

    const changedPrepared = await pipeline.prepare(sourceText, { targetBatchSize: 4 });
    const changedRun = await pipeline.normalize(changedPrepared, ['林夏'], { existing: firstRun });

    expect(changedPrepared.segmentation.planFingerprint).not.toBe(firstPrepared.segmentation.planFingerprint);
    expect(requests.filter((request) => request.stage === 'normalization').length)
      .toBe(beforeChangedPlan + changedPrepared.segments.length);
    expect(changedRun.tasks).toHaveLength(changedPrepared.segments.length);
  });

  it('restores the draft reading speed after the global speed changes', async () => {
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'reading-speed-restore',
      sourceText: '旁白。',
      anchorMode: 'zero',
      scriptReadingSpeed: 14,
    });
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        if (request.stage === 'segmentation') return { content: JSON.stringify({ boundaryIds: [] }) };
        if (request.stage === 'characterExtraction') return { content: JSON.stringify({ mainCharacters: [] }) };
        if (request.stage === 'normalization') {
          return { content: JSON.stringify({ statements: [{ speaker: '', text: `${'甲'.repeat(20)}。` }] }) };
        }
        return { content: JSON.stringify({ gapSeconds: [] }) };
      },
    };
    const pipeline = new AiProsePipeline(
      new AiProseLlmService(createConfiguration(), transport),
      { scriptReadingSpeed: 7 },
    );

    const prepared = await pipeline.prepare(draft.sourceText, {
      targetBatchSize: 100,
      sourceRevision: draft.sourceRevision,
      existingDraft: draft,
    });
    const normalization = await pipeline.normalize(prepared, {
      confirmedMainCharacters: [],
      mainCharactersConfirmed: true,
    });
    const rhythm = await pipeline.rhythm(prepared, normalization);

    expect(prepared.scriptReadingSpeed).toBe(14);
    expect(rhythm.preview.statements[0].durationSeconds).toBe(1.8);
  });

  it('drops stale revision/name checkpoints and re-requests rhythm for changed final blocks', async () => {
    const requests: AiProseLlmRequest[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: ['L0001', 'L0002'] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: ['林夏'] }) };
        }
        if (request.stage === 'normalization') {
          const match = request.userPrompt.match(/故事段 (\d+)/u);
          return {
            content: JSON.stringify({
              statements: [{ speaker: '林夏', text: `${match?.[1] ?? '0'}段。` }],
            }),
          };
        }
        return { content: JSON.stringify({ gapSeconds: [] }) };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(createConfiguration(), transport));
    const prepared = await pipeline.prepare('A段。\nB段。\nC段。', {
      targetBatchSize: 4,
      sourceRevision: 1,
    });
    const normalization = await pipeline.normalize(prepared, ['林夏']);
    const rhythm = await pipeline.rhythm(prepared, normalization);

    const beforeSourceChange = requests.length;
    const changedPrepared = await pipeline.prepare('A新。\nB新。\nC新。', {
      targetBatchSize: 4,
      sourceRevision: 2,
      existingPrepared: prepared,
    });
    expect(requests.length).toBe(beforeSourceChange + 2);

    const beforeNameChange = requests.length;
    const renamed = await pipeline.normalize(changedPrepared, {
      confirmedMainCharacters: ['周衡'],
      mainCharactersConfirmed: true,
    }, { existing: normalization });
    expect(requests.length).toBe(beforeNameChange + 3);
    expect(renamed.tasks.every((task) => task.status === 'succeeded')).toBe(true);

    const changedNormalization = {
      ...normalization,
      tasks: normalization.tasks.map((task, index) => index === 0
        ? { ...task, statements: [{ speaker: '林夏', text: '正文已变。' }] }
        : task),
    };
    const beforeRhythmChange = requests.length;
    await pipeline.rhythm(prepared, changedNormalization, { existing: rhythm });
    // Every changed segment contains one final block, so there is no
    // segment-internal boundary to send to the rhythm model.
    expect(requests.length).toBe(beforeRhythmChange);
  });

  it('emits stage checkpoints without persisting provider identity or credentials', async () => {
    const preparedCheckpoints: string[] = [];
    const normalizationCheckpoints: number[] = [];
    const rhythmCheckpoints: number[] = [];
    const checkpoint = {
      onPrepared: (prepared: { sourceText: string }) => {
        preparedCheckpoints.push(prepared.sourceText);
      },
      onNormalizationTask: (context: { task: { segmentIndex: number }; confirmedMainCharacters: readonly string[] }) => {
        normalizationCheckpoints.push(context.task.segmentIndex);
        expect(context.confirmedMainCharacters).toEqual(['林夏']);
        expect(context).not.toHaveProperty('model');
        expect(context).not.toHaveProperty('apiKey');
      },
      onRhythmTask: (context: { task: { segmentIndex: number } }) => {
        rhythmCheckpoints.push(context.task.segmentIndex);
      },
    };
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: ['L0001'] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: ['林夏'] }) };
        }
        if (request.stage === 'normalization') {
          return { content: JSON.stringify({ statements: [{ speaker: '林夏', text: '一句。' }] }) };
        }
        return { content: JSON.stringify({ gapSeconds: [] }) };
      },
    };
    const pipeline = new AiProsePipeline(
      new AiProseLlmService(createConfiguration(), transport),
      { checkpoint },
    );
    const prepared = await pipeline.prepare('第一段。\n第二段。', { targetBatchSize: 4 });
    const normalization = await pipeline.normalize(prepared, ['林夏']);
    await pipeline.rhythm(prepared, normalization);

    expect(preparedCheckpoints).toEqual(['第一段。\n第二段。']);
    expect(normalizationCheckpoints).toEqual([0, 1]);
    expect(rhythmCheckpoints).toEqual([0, 1]);
  });

  it('serializes optional draft persistence checkpoints without provider fields', async () => {
    const saved: Array<Record<string, unknown>> = [];
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'pipeline-checkpoint',
      sourceText: '第一段。',
      anchorMode: 'zero',
    });
    const checkpoint = createAiProseDraftPersistenceCheckpoint({
      persistence: {
        saveCheckpoint: async (_project, nextDraft) => {
          saved.push(structuredClone(nextDraft) as unknown as Record<string, unknown>);
          return 'draft-path';
        },
      },
      project: {
        projectRoot: '/projects/demo',
        assetRoots: { project: 'project-assets' },
      },
      draft,
    });
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: [] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: [] }) };
        }
        if (request.stage === 'normalization') {
          return { content: JSON.stringify({ statements: [{ speaker: '', text: '第一段。' }] }) };
        }
        return { content: JSON.stringify({ gapSeconds: [] }) };
      },
    };
    const pipeline = new AiProsePipeline(
      new AiProseLlmService(createConfiguration(), transport),
      { checkpoint },
    );
    const prepared = await pipeline.prepare('第一段。', { sourceRevision: 0, targetBatchSize: 100 });
    const normalization = await pipeline.normalize(prepared, {
      confirmedMainCharacters: [],
      mainCharactersConfirmed: true,
    });
    await pipeline.rhythm(prepared, normalization);

    expect(saved.length).toBeGreaterThanOrEqual(5);
    expect(checkpoint.getDraft()).toMatchObject({
      status: 'active',
      sourceRevision: 0,
      normalization: [{ status: 'succeeded' }],
      rhythm: [{ status: 'succeeded' }],
      preview: expect.any(Object),
    });
    expect(JSON.stringify(saved)).not.toContain('default-model');
    expect(JSON.stringify(saved)).not.toContain('apiKey');

    const beforeRestore = saved.length;
    const recoveredDraft = checkpoint.getDraft();
    const restoredNormalization = await pipeline.normalize(prepared, {
      confirmedMainCharacters: [],
      mainCharactersConfirmed: true,
    }, { existingDraft: recoveredDraft });
    await pipeline.rhythm(prepared, restoredNormalization, { existingDraft: recoveredDraft });
    expect(saved.length).toBeGreaterThan(beforeRestore);
  });

  it('preserves normalized statements when prepare rehydrates an unchanged draft', async () => {
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'prepare-rehydrate',
      sourceText: '第一段。',
      anchorMode: 'zero',
      targetBatchSize: 100,
    });
    const checkpoint = createAiProseDraftPersistenceCheckpoint({
      persistence: {
        saveCheckpoint: async () => 'draft-path',
      },
      project: {
        projectRoot: '/projects/demo',
        assetRoots: { project: 'project-assets' },
      },
      draft,
    });
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        if (request.stage === 'segmentation') return { content: JSON.stringify({ boundaryIds: [] }) };
        if (request.stage === 'characterExtraction') return { content: JSON.stringify({ mainCharacters: [] }) };
        if (request.stage === 'normalization') {
          return { content: JSON.stringify({ statements: [{ speaker: '', text: '第一段。' }] }) };
        }
        return { content: JSON.stringify({ gapSeconds: [] }) };
      },
    };
    const pipeline = new AiProsePipeline(
      new AiProseLlmService(createConfiguration(), transport),
    );
    const prepared = await pipeline.prepare('第一段。', {
      sourceRevision: 0,
      targetBatchSize: 100,
      checkpoint,
    });
    const normalization = await pipeline.normalize(prepared, {
      confirmedMainCharacters: [],
      mainCharactersConfirmed: true,
    }, { checkpoint });
    await pipeline.rhythm(prepared, normalization, { checkpoint });

    const completed = checkpoint.getDraft();
    await pipeline.prepare(completed.sourceText, {
      sourceRevision: completed.sourceRevision,
      targetBatchSize: completed.targetBatchSize,
      anchorTime: completed.anchorTime,
      existing: completed,
      existingDraft: completed,
      checkpoint,
    });

    expect(checkpoint.getDraft().normalization).toEqual(completed.normalization);
    expect(checkpoint.getDraft().preview).toEqual(completed.preview);
  });

  it('invalidates the timing preview when rehydration changes the reading speed', async () => {
    const draft = createDraft({
      sceneId: 'scene-1',
      sessionId: 'prepare-speed-change',
      sourceText: '第一段。',
      anchorMode: 'zero',
      targetBatchSize: 100,
    });
    const checkpoint = createAiProseDraftPersistenceCheckpoint({
      persistence: {
        saveCheckpoint: async () => 'draft-path',
      },
      project: {
        projectRoot: '/projects/demo',
        assetRoots: { project: 'project-assets' },
      },
      draft,
    });
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        if (request.stage === 'segmentation') return { content: JSON.stringify({ boundaryIds: [] }) };
        if (request.stage === 'characterExtraction') return { content: JSON.stringify({ mainCharacters: [] }) };
        if (request.stage === 'normalization') {
          return { content: JSON.stringify({ statements: [{ speaker: '', text: '第一段。' }] }) };
        }
        return { content: JSON.stringify({ gapSeconds: [] }) };
      },
    };
    const pipeline = new AiProsePipeline(
      new AiProseLlmService(createConfiguration(), transport),
    );
    const prepared = await pipeline.prepare('第一段。', {
      sourceRevision: 0,
      targetBatchSize: 100,
      checkpoint,
    });
    const normalization = await pipeline.normalize(prepared, {
      confirmedMainCharacters: [],
      mainCharactersConfirmed: true,
    }, { checkpoint });
    await pipeline.rhythm(prepared, normalization, { checkpoint });

    const completed = checkpoint.getDraft();
    expect(completed.preview).not.toBeNull();
    await pipeline.prepare(completed.sourceText, {
      sourceRevision: completed.sourceRevision,
      targetBatchSize: completed.targetBatchSize,
      anchorTime: completed.anchorTime,
      scriptReadingSpeed: 14,
      existing: completed,
      checkpoint,
    });

    expect(checkpoint.getDraft().scriptReadingSpeed).toBe(14);
    expect(checkpoint.getDraft().normalization).toEqual(completed.normalization);
    expect(checkpoint.getDraft().rhythm).toEqual(completed.rhythm);
    expect(checkpoint.getDraft().preview).toBeNull();
  });

  it('requests rhythm per final segment blocks, clamps finite values, and keeps cross-segment gaps fixed', async () => {
    const requests: AiProseLlmRequest[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: ['L0001'] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: ['林夏'] }) };
        }
        if (request.stage === 'normalization') {
          const match = request.userPrompt.match(/故事段 (\d+)/u);
          const segmentIndex = Number(match?.[1] ?? 0) - 1;
          return {
            content: JSON.stringify({
              statements: [
                { speaker: '林夏', text: `${segmentIndex === 0 ? '甲' : '乙'}第一句。` },
                { speaker: '', text: `${segmentIndex === 0 ? '甲' : '乙'}第二句。` },
              ],
            }),
          };
        }
        const match = request.userPrompt.match(/故事段 (\d+)/u);
        return {
          content: JSON.stringify({
            gapSeconds: [Number(match?.[1] ?? 0) === 1 ? 0.1 : 0.9],
          }),
        };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(createConfiguration(), transport));
    const prepared = await pipeline.prepare('甲段。\n乙段。', { targetBatchSize: 4 });
    const normalization = await pipeline.normalize(prepared, ['林夏']);
    const rhythm = await pipeline.rhythm(prepared, normalization);

    expect(rhythm.status).toBe('succeeded');
    expect(rhythm.tasks.map((task) => task.gapSeconds)).toEqual([[0.25], [0.75]]);
    expect(rhythm.tasks.every((task) => task.usedFallback !== true)).toBe(true);
    expect(rhythm.preview?.statements.map((statement) => statement.gapSecondsToNext)).toEqual([
      0.25,
      0.5,
      0.75,
      0,
    ]);
    const rhythmRequests = requests.filter((request) => request.stage === 'rhythm');
    expect(rhythmRequests).toHaveLength(2);
    expect(rhythmRequests[0].userPrompt).toContain('甲第一句');
    expect(rhythmRequests[0].userPrompt).not.toContain('乙第一句');
    expect(rhythmRequests[1].userPrompt).toContain('乙第一句');
    expect(rhythmRequests[1].userPrompt).not.toContain('甲第一句');
  });

  it('uses the injected ordinary script reading speed and keeps a fractional anchor', async () => {
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: [] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: [] }) };
        }
        if (request.stage === 'normalization') {
          return {
            content: JSON.stringify({
              statements: [{ speaker: '', text: `${'甲'.repeat(20)}。` }],
            }),
          };
        }
        return { content: JSON.stringify({ gapSeconds: [] }) };
      },
    };
    const pipeline = new AiProsePipeline(
      new AiProseLlmService(createConfiguration(), transport),
      { scriptReadingSpeed: 14 },
    );
    const prepared = await pipeline.prepare('旁白。', {
      targetBatchSize: 100,
      anchorTime: 12.34,
    });
    const normalization = await pipeline.normalize(prepared, {
      confirmedMainCharacters: [],
      mainCharactersConfirmed: true,
    });
    const rhythm = await pipeline.rhythm(prepared, normalization);

    expect(rhythm.preview.anchorTime).toBe(12.34);
    expect(rhythm.preview.statements[0].time).toBe(12.34);
    expect(rhythm.preview.statements[0].durationSeconds).toBe(1.8);
  });

  it('falls back only the rhythm segment after one correction failure without failing normalization', async () => {
    const requests: AiProseLlmRequest[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        if (request.stage === 'segmentation') {
          return { content: JSON.stringify({ boundaryIds: ['L0001'] }) };
        }
        if (request.stage === 'characterExtraction') {
          return { content: JSON.stringify({ mainCharacters: ['林夏'] }) };
        }
        if (request.stage === 'normalization') {
          return {
            content: JSON.stringify({
              statements: [
                { speaker: '林夏', text: '一句。' },
                { speaker: '', text: '两句。' },
              ],
            }),
          };
        }
        const match = request.userPrompt.match(/故事段 (\d+)/u);
        if (Number(match?.[1] ?? 0) === 2) return { content: 'invalid rhythm' };
        return { content: JSON.stringify({ gapSeconds: [0.5] }) };
      },
    };
    const pipeline = new AiProsePipeline(new AiProseLlmService(createConfiguration(), transport));
    const prepared = await pipeline.prepare('甲段。\n乙段。', { targetBatchSize: 4 });
    const normalization = await pipeline.normalize(prepared, ['林夏']);
    const rhythm = await pipeline.rhythm(prepared, normalization);

    expect(normalization.status).toBe('succeeded');
    expect(rhythm.status).toBe('succeeded');
    expect(rhythm.tasks[0]).toMatchObject({ gapSeconds: [0.5] });
    expect(rhythm.tasks[1]).toMatchObject({
      gapSeconds: [0.35],
      usedFallback: true,
      status: 'succeeded',
    });
    expect(requests.filter((request) => request.stage === 'rhythm')).toHaveLength(3);
    expect(rhythm.preview.statements).toHaveLength(4);
  });
});
