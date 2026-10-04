import { afterEach, describe, expect, it } from 'vitest';
import {
  createSemanticStatementDraftForResource,
  createSemanticStatementDraftForBlock,
  SEMANTIC_STATEMENT_BLOCKS,
} from '../ui/timeline/semanticStatementBlocks';
import { sceneStatementDefinitionRegistry } from '../services/semantic-scene';
import { DEFAULT_SETTINGS, settingsManager } from '../ui/SettingsStore';

describe('semantic statement blocks', () => {
  afterEach(() => {
    settingsManager.set('defaultDialogueDurationSeconds', DEFAULT_SETTINGS.defaultDialogueDurationSeconds);
  });

  it('exposes the seven ADR domain categories for timeline insertion', () => {
    const categories = [...new Set(SEMANTIC_STATEMENT_BLOCKS.map((block) => block.category))];

    expect(categories).toEqual([
      'dialogue',
      'character',
      'camera',
      'scene',
      'visual',
      'audio',
      'layer',
    ]);
    expect(categories).not.toContain('environment');
    expect(categories).not.toContain('media');
  });

  it('creates resource statements with empty paths for later inspector editing', () => {
    const bgm = createSemanticStatementDraftForBlock('audio.bgm', {});
    const sfx = createSemanticStatementDraftForBlock('audio.sfx', {});

    expect(bgm).toMatchObject({
      type: 'audio',
      params: { role: 'bgm', mode: 'play', file: '' },
    });
    expect(sfx).toMatchObject({
      type: 'audio',
      params: { role: 'sfx', mode: 'play', file: '' },
    });

    expect(createSemanticStatementDraftForBlock('audio.bgm', { filePath: 'bgm/theme.ogg' })).toMatchObject({
      type: 'audio',
      params: {
        role: 'bgm',
        mode: 'play',
        file: 'bgm/theme.ogg',
        loop: true,
      },
    });
    expect(createSemanticStatementDraftForBlock('audio.sfx', { filePath: 'sfx/click.ogg' })).toMatchObject({
      type: 'audio',
      params: {
        role: 'sfx',
        mode: 'play',
        file: 'sfx/click.ogg',
      },
    });

    expect(createSemanticStatementDraftForResource({ sourceKind: 'figure', filePath: '' })).toMatchObject({
      type: 'characterPresence',
      params: { model: '' },
    });
    expect(createSemanticStatementDraftForResource({ sourceKind: 'vocal', filePath: '' })).toMatchObject({
      type: 'dialogue',
      params: { voice: '' },
    });
    expect(createSemanticStatementDraftForResource({ sourceKind: 'animation', filePath: '' })).toMatchObject({
      type: 'customAnimation',
      params: { file: '' },
    });
  });

  it('keeps dialogue resource inserts unbound without an explicit character scope', () => {
    const sceneMeta = { title: 'Narrator inserts', characters: [{ id: 'hero', name: 'Hero' }] };
    const dialogue = createSemanticStatementDraftForBlock('dialogue.basic', { sceneMeta });
    const vocal = createSemanticStatementDraftForResource({ sceneMeta, sourceKind: 'vocal', filePath: 'voice/line.wav' });

    expect(dialogue).toEqual({
      type: 'dialogue',
      params: { text: '新对白', durationSeconds: 2 },
    });
    expect(vocal).toMatchObject({
      type: 'dialogue',
      params: { text: '新对白', voice: 'voice/line.wav', durationSeconds: 2 },
    });
    expect(vocal?.params).not.toHaveProperty('speakerId');
  });

  it('uses the configured default duration for library and vocal resource dialogue drafts', () => {
    settingsManager.set('defaultDialogueDurationSeconds', 4.5);

    expect(createSemanticStatementDraftForBlock('dialogue.basic', {})).toMatchObject({
      type: 'dialogue',
      params: { text: '新对白', durationSeconds: 4.5 },
    });
    expect(createSemanticStatementDraftForResource({
      sourceKind: 'vocal',
      filePath: 'voice/line.wav',
    })).toMatchObject({
      type: 'dialogue',
      params: { text: '新对白', voice: 'voice/line.wav', durationSeconds: 4.5 },
    });
  });

  it('exposes character performance entries for look-at and blink', () => {
    const context = {
      charId: 'hero',
      sceneMeta: { title: 'LookAt and Blink', characters: [{ id: 'hero', name: 'Hero' }] },
    };

    const lookAtDraft = createSemanticStatementDraftForBlock('character.performance.look-at', context);
    expect(lookAtDraft).toEqual({
      type: 'characterPerformance',
      params: {
        target: 'hero',
        lookAt: {
          point: [0, 0],
          intensity: 1,
          enabled: true,
        },
      },
    });

    const blinkDraft = createSemanticStatementDraftForBlock('character.performance.blink', context);
    expect(blinkDraft).toEqual({
      type: 'characterPerformance',
      params: {
        target: 'hero',
        blink: {
          enabled: true,
          interval: 4,
        },
      },
    });
  });

  it('exposes a character color integration entry and targets the integration slot', () => {
    const draft = createSemanticStatementDraftForBlock('visual.character-integration', {
      charId: 'hero',
      sceneMeta: { title: 'Integration', characters: [{ id: 'hero', name: 'Hero' }] },
    });

    expect(draft).toMatchObject({
      type: 'visualStyle',
      params: {
        scope: 'object',
        target: 'hero',
        slot: 'integration',
        mode: 'set',
        recipeId: 'builtin:integration-soft',
      },
    });
  });

  it('keeps active State Span end commands in parity with registry lifecycle types', () => {
    const registryTypes = new Set(
      sceneStatementDefinitionRegistry.listLifecyclePresentations().map((item) => item.presentationTypeKey),
    );
    const commandTypes = new Set(
      SEMANTIC_STATEMENT_BLOCKS.flatMap((block) => (
        block.lifecycleEndCommand ? [block.lifecycleEndCommand.presentationTypeKey] : []
      )),
    );

    expect(commandTypes).toEqual(registryTypes);
  });

  it('creates lighting post set and modulate drafts with explicit overlay fields aligned with runtime defaults', () => {
    const postSetDraft = createSemanticStatementDraftForBlock('lighting.post', {});
    expect(postSetDraft).toMatchObject({
      type: 'lighting',
      params: {
        effect: 'post',
        mode: 'set',
        target: 'panorama',
        overlayColor: '#ffffff',
        overlayBlendMode: 'multiply',
        overlayIntensity: 0,
      },
    });

    const postModulateDraft = createSemanticStatementDraftForBlock('lighting.modulate-post', {});
    expect(postModulateDraft).toMatchObject({
      type: 'lighting',
      params: {
        effect: 'post',
        mode: 'modulate',
        target: 'panorama',
        overlayColor: '#ffffff',
        overlayBlendMode: 'multiply',
        overlayIntensity: 0,
      },
    });
  });
});
