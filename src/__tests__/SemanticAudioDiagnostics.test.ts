import { describe, expect, it } from 'vitest';
import {
  sceneDocumentCodec,
  validateSemanticSceneStructure,
  SEMANTIC_AUDIO_DIAGNOSTIC_CODES,
} from '../services/semantic-scene';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';

function makeDocument(statements: unknown[]): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'semantic-audio-diagnostics',
    meta: {
      title: 'Semantic audio diagnostics',
      characters: [
        { id: 'tomori', name: 'Tomori', model: 'figure/tomori/model.json' },
      ],
    },
    statements,
  });
}

describe('semantic audio diagnostics', () => {
  it('does not warn when dialogue voice duration is unspecified or within duration window', () => {
    const documentUnspecified = makeDocument([
      {
        id: 'line_unspecified',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: '第一句',
          voice: 'vocal/line1.wav',
          durationSeconds: 2,
        },
      },
    ]);
    const issuesUnspecified = validateSemanticSceneStructure(documentUnspecified);
    const unspecIssue = issuesUnspecified.find((issue) => issue.code === SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceWindowTruncated);
    expect(unspecIssue).toBeUndefined();

    const documentFitting = makeDocument([
      {
        id: 'line_fitting',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: '第一句',
          voice: 'vocal/line1.wav',
          durationSeconds: 2,
          voiceDuration: 1.8,
        },
      },
    ]);
    const issuesFitting = validateSemanticSceneStructure(documentFitting);
    const fittingIssue = issuesFitting.find((issue) => issue.code === SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceWindowTruncated);
    expect(fittingIssue).toBeUndefined();
  });

  it('diagnoses audio that is truncated by dialogue duration', () => {
    const document = makeDocument([
      {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: '第一句',
          voice: 'vocal/line1.wav',
          durationSeconds: 2,
          voiceDuration: 3,
        },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);
    const line1Issue = issues.find((issue) => issue.actionId === 'line_1' && issue.code === SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceWindowTruncated);

    expect(line1Issue).toBeDefined();
    expect(line1Issue?.severity).toBe('warning');
    expect(line1Issue?.message).toMatch(/会被当前 dialogue\.duration.*截断/);
    expect(line1Issue?.location).toBe('scene.statements["line_1"].params.voice');

    // Also verify duration map in options detects truncation
    const documentWithoutParamDuration = makeDocument([
      {
        id: 'line_opt',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: '第一句',
          voice: 'vocal/line1.wav',
          durationSeconds: 2,
        },
      },
    ]);
    const issuesWithOptions = validateSemanticSceneStructure(documentWithoutParamDuration, {
      audioDurations: { 'vocal/line1.wav': 2.5 },
    });
    const optionIssue = issuesWithOptions.find((issue) => issue.actionId === 'line_opt' && issue.code === SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceWindowTruncated);
    expect(optionIssue).toBeDefined();
    expect(optionIssue?.severity).toBe('warning');
  });

  it('diagnoses dialogue voice with disabled lipSync', () => {
    const document = makeDocument([
      {
        id: 'line_lipsync_off',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: '第一句',
          voice: 'vocal/line1.wav',
          durationSeconds: 2,
          lipSync: false,
        },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);
    const lipSyncIssue = issues.find((issue) => issue.actionId === 'line_lipsync_off' && issue.code === SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceLipSyncDisabled);

    expect(lipSyncIssue).toBeDefined();
    expect(lipSyncIssue?.severity).toBe('warning');
    expect(lipSyncIssue?.message).toContain('lipSync 为 none');
  });

  it('diagnoses voice cut-off when consecutive dialogues are spaced closer than MIN_AUDIO_GAP', () => {
    const document = makeDocument([
      {
        id: 'line_1',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: '第一句',
          voice: 'vocal/line1.wav',
          durationSeconds: 2,
        },
      },
      {
        id: 'line_2',
        time: 2.98,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: '第二句',
          voice: 'vocal/line2.wav',
          durationSeconds: 1.5,
        },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);
    const cutOffIssue = issues.find((issue) => issue.actionId === 'line_1' && issue.code === SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceCutOff);

    expect(cutOffIssue).toBeDefined();
    expect(cutOffIssue?.severity).toBe('warning');
    expect(cutOffIssue?.message).toContain('下一句对白在当前对白结束前');

    // Also test gap < 50ms without overlap
    const documentCloseGap = makeDocument([
      {
        id: 'line_a',
        time: 1,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: '句A', voice: 'vocal/line1.wav', durationSeconds: 2 },
      },
      {
        id: 'line_b',
        time: 3.02,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: '句B', voice: 'vocal/line2.wav', durationSeconds: 1 },
      },
    ]);
    const closeGapIssue = validateSemanticSceneStructure(documentCloseGap).find(
      (issue) => issue.actionId === 'line_a' && issue.code === SEMANTIC_AUDIO_DIAGNOSTIC_CODES.dialogueVoiceCutOff,
    );
    expect(closeGapIssue).toBeDefined();
    expect(closeGapIssue?.message).toContain('间隔不足 50ms');
  });

  it('diagnoses companion audio exceeding dialogue duration', () => {
    const document = makeDocument([
      {
        id: 'line_with_companion',
        time: 1,
        type: 'dialogue',
        params: {
          speakerId: 'tomori',
          text: '伴随测试',
          durationSeconds: 2,
        },
        companions: [
          {
            id: 'companion_sfx_long',
            anchor: 'start',
            offset: 0,
            type: 'audio',
            params: {
              role: 'sfx',
              mode: 'play',
              instanceId: 'sfx_1',
              file: 'audio/explosion.wav',
              durationSeconds: 4,
            },
          },
        ],
      },
    ]);

    const issues = validateSemanticSceneStructure(document);
    const companionIssue = issues.find((issue) => issue.code === SEMANTIC_AUDIO_DIAGNOSTIC_CODES.companionAudioExceedsDialogue);

    expect(companionIssue).toBeDefined();
    expect(companionIssue?.severity).toBe('warning');
    expect(companionIssue?.message).toContain('超过了对白持续时间');
  });

  it('diagnoses standalone audio statements overlapping and truncation', () => {
    const document = makeDocument([
      {
        id: 'audio_1',
        time: 0,
        type: 'audio',
        params: {
          role: 'sfx',
          mode: 'play',
          instanceId: 'sfx_1',
          file: 'audio/bg.wav',
          durationSeconds: 2,
        },
      },
      {
        id: 'audio_2',
        time: 1.98,
        type: 'audio',
        params: {
          role: 'sfx',
          mode: 'play',
          instanceId: 'sfx_2',
          file: 'audio/bg2.wav',
          durationSeconds: 1,
        },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);
    const overlapIssue = issues.find((issue) => issue.actionId === 'audio_2' && issue.code === SEMANTIC_AUDIO_DIAGNOSTIC_CODES.audioOverlapTruncated);

    expect(overlapIssue).toBeDefined();
    expect(overlapIssue?.severity).toBe('warning');
    expect(overlapIssue?.message).toContain('可能发生重叠或截断');
  });
});
