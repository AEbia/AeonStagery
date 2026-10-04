import { describe, expect, it, vi } from 'vitest';
import { VoiceAuthoringService } from '../services/voice/VoiceAuthoringService';
import type { LocalVoicePreset } from '../services/voice/VoiceAuthoringTypes';

function createHarness() {
  const electron = {
    scanCatalog: vi.fn(), listPresets: vi.fn(), savePreset: vi.fn(), renamePreset: vi.fn(),
    duplicatePreset: vi.fn(), deletePreset: vi.fn(), publishTemplateProfile: vi.fn(), generateCandidate: vi.fn(), clearSession: vi.fn(),
    resolveReference: vi.fn(async (_presetId: string, referenceId: string) => ({ success: true, absolutePath: `D:/library/${referenceId}.wav` })),
  };
  const project = {
    rootPath: 'D:/project',
    projectFilePath: 'D:/project/project.json',
    metadata: { projectId: 'project-1', voiceProfiles: [] },
  } as any;
  const projectResources = {
    getCurrentProject: vi.fn(() => project),
    importGeneratedVoiceCandidate: vi.fn(async () => ({ mode: 'copy', kind: 'vocal', relativePath: 'vocal/generated/candidate.wav' })),
    importVoiceReference: vi.fn(async (_source: string, presetId: string, referenceId: string) => ({ mode: 'copy', kind: 'vocal', relativePath: `vocal/reference/${presetId}/${referenceId}.wav` })),
    removeProjectResource: vi.fn(async () => undefined),
  };
  const semanticAuthoring = {
    getDocumentSnapshot: vi.fn(() => ({
      schemaVersion: 4,
      sceneId: 'scene-1',
      meta: { title: 'Voice test' },
      statements: [{
        id: 'dialogue-1',
        time: 0,
        type: 'dialogue',
        params: { text: 'same', durationSeconds: 2 },
      }],
    })),
    author: vi.fn(async () => ({})),
    applyCharacterCommand: vi.fn(async () => ({
      kind: 'set-character-voice-profile',
      affectedCharacterIds: ['char-1'],
      affectedStatementIds: [],
      affectedCompanionLocators: [],
    })),
  };
  const workspace = { updateVoiceProfiles: vi.fn(async () => ({ success: true, project })) };
  const service = new VoiceAuthoringService(electron as any, projectResources as any, semanticAuthoring as any, workspace as any);
  return { service, electron, projectResources, semanticAuthoring, workspace };
}

describe('VoiceAuthoringService', () => {
  it('projectizes candidate audio before committing only voice and lipSync', async () => {
    const { service, projectResources, semanticAuthoring } = createHarness();
    const receipt = await service.adoptCandidate({
      candidatePath: 'D:/cache/candidate.wav', candidateId: 'candidate', candidateText: 'same', dialogueText: 'same',
      statementId: 'dialogue-1', projectId: 'project-1', mode: 'apply',
    });

    expect(receipt.success).toBe(true);
    expect(projectResources.importGeneratedVoiceCandidate).toHaveBeenCalledBefore(semanticAuthoring.author);
    expect(semanticAuthoring.author).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'update-statement',
      statementId: 'dialogue-1',
      patch: { params: { text: 'same', durationSeconds: 2, voice: 'vocal/generated/candidate.wav', lipSync: true } },
    }));
  });

  it('rejects mismatched dialogue text unless synchronization is explicit', async () => {
    const { service, projectResources, semanticAuthoring } = createHarness();
    const receipt = await service.adoptCandidate({
      candidatePath: 'D:/cache/candidate.wav', candidateId: 'candidate', candidateText: 'new', dialogueText: 'old',
      statementId: 'dialogue-1', projectId: 'project-1', mode: 'apply',
    });

    expect(receipt.success).toBe(false);
    expect(projectResources.importGeneratedVoiceCandidate).not.toHaveBeenCalled();
    expect(semanticAuthoring.author).not.toHaveBeenCalled();
  });

  it('removes a newly imported unreferenced file when the timeline commit fails', async () => {
    const { service, projectResources, semanticAuthoring } = createHarness();
    semanticAuthoring.author.mockRejectedValueOnce(new Error('commit failed'));
    const receipt = await service.adoptCandidate({
      candidatePath: 'D:/cache/candidate.wav', candidateId: 'candidate', candidateText: 'same', dialogueText: 'same',
      statementId: 'dialogue-1', projectId: 'project-1', mode: 'apply',
    });

    expect(receipt.success).toBe(false);
    expect(projectResources.removeProjectResource).toHaveBeenCalledWith('vocal/generated/candidate.wav');
  });

  it('materializes portable references before persisting and assigning a character profile', async () => {
    const { service, projectResources, workspace, semanticAuthoring } = createHarness();
    const preset: LocalVoicePreset = {
      id: 'tomori', name: 'Tomori',
      gptModel: { absolutePath: 'D:/models/tomori.ckpt', fileName: 'tomori.ckpt', relativePathSuffix: 'voices/tomori.ckpt' },
      sovitsModel: { absolutePath: 'D:/models/tomori.pth', fileName: 'tomori.pth' },
      references: [{ id: 'primary', label: 'Primary', managedPath: 'references/tomori/primary.wav', role: 'primary', promptText: 'hello', promptLang: 'en' }],
      inferenceDefaults: { textLang: 'en', speed: 1 }, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    };
    const receipt = await service.setCharacterDefault(preset, 'char-1');

    expect(receipt.success).toBe(true);
    expect(projectResources.importVoiceReference).toHaveBeenCalledWith('D:/library/primary.wav', 'tomori', 'primary');
    expect(workspace.updateVoiceProfiles).toHaveBeenCalledWith([expect.objectContaining({
      id: 'tomori',
      gptModel: { fileName: 'tomori.ckpt', relativePathSuffix: 'voices/tomori.ckpt' },
      references: [expect.objectContaining({ projectPath: 'vocal/reference/tomori/primary.wav' })],
    })]);
    expect(semanticAuthoring.applyCharacterCommand).toHaveBeenCalledWith({ kind: 'set-character-voice-profile', origin: 'voice-workbench', charId: 'char-1', voiceProfileId: 'tomori' });
  });
});
