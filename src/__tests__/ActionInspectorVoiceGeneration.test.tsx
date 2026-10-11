/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import { ActionInspector } from '../ui/timeline/ActionInspector';
import { settingsManager } from '../ui/SettingsStore';
import { DocumentStore } from '../ui/store/DocumentStore';
import { EditorStore } from '../ui/store/EditorStore';
import { PlaybackStore } from '../ui/store/PlaybackStore';
import { ValidationStore } from '../ui/store/ValidationStore';
import type { ProjectState } from '../api/types/project';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { TimelineScene } from '../ui/timeline/semanticTimelineTypes';
import { eventBus } from '../api/events';

const showToastMock = vi.fn();

vi.mock('../ui/Toast', () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

function makeDocument(text = '我想继续唱下去。'): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_1',
    meta: {
      title: 'Test Scene',
      characters: [],
      markers: [],
    },
    statements: [
      {
        id: 'dialogue_1',
        time: 1,
        type: 'dialogue',
        params: {
          text,
          speakerId: 'tomori',
          durationSeconds: 2,
          voice: 'vocal/manual.wav',
        },
      },
    ],
  };
}

function makeScene(document: CurrentSceneDocument): TimelineScene {
  const statement = document.statements[0];
  return {
    sceneId: document.sceneId,
    meta: document.meta,
    timeline: statement ? [{
      _id: statement.id,
      time: statement.time,
      action: statement.type,
      params: statement.params,
      sourceParams: statement.params,
    }] : [],
  };
}

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    rootPath: 'D:\\projects\\voice-demo',
    projectFilePath: 'D:\\projects\\voice-demo\\project.json',
    metadata: {
      projectId: 'project_1',
      name: 'Voice Demo',
      projectVersion: 2,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
      defaultSceneId: 'scene_1',
      scenes: [{ id: 'scene_1', name: 'Scene 1', path: 'main.scene.json' }],
      assetRoots: {
        figure: 'figure',
        background: 'background',
        bgm: 'bgm',
        vocal: 'vocal',
        images: 'images',
        animation: 'animation',
        project: 'project',
        template: 'template',
      },
      voiceGeneration: {
        gptSovits: {
          selectedPresetId: 'tomori',
          presets: [
            {
              id: 'tomori',
              name: '灯',
              gptWeightsPath: 'D:\\models\\tomori.ckpt',
              sovitsWeightsPath: 'D:\\models\\tomori.pth',
              refAudioPath: 'D:\\refs\\tomori.wav',
              promptText: '我想继续唱下去。',
              promptLang: 'zh',
              textLang: 'zh',
              speed: 1,
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

function renderInspector({
  document = makeDocument(),
  project = makeProject(),
}: {
  document?: CurrentSceneDocument;
  project?: ProjectState | null;
} = {}) {
  const scene = makeScene(document);
  const documentStore = new DocumentStore();
  const editorStore = new EditorStore();
  const playbackStore = new PlaybackStore();
  const validationStore = new ValidationStore();
  documentStore._replaceCurrentSceneDocumentSnapshot(document);
  editorStore._setSelectedIds({ dialogue_1: true });

  const updateAction = vi.fn();
  const projectWorkspace = {
    getCurrentProject: vi.fn(() => project),
    subscribe: vi.fn(() => () => {}),
    createProjectAt: vi.fn(),
    openProjectAt: vi.fn(),
    prepareCollaborationProjectAt: vi.fn(),
    updateTemplateConfiguration: vi.fn(),
    updateVoiceGenerationConfiguration: vi.fn(),
    updateVoiceProfiles: vi.fn(),
    prepareTemplateCharacters: vi.fn(),
  };

  const result = render(
    <AppProvider
      adapters={{
        playback: {
          seek: vi.fn(),
          getCurrentTime: () => 0,
          subscribeTime: () => () => {},
        } as any,
        camera: {} as any,
        character: {
          getModelDataFromPath: vi.fn(async () => ({ motions: [], expressions: [] })),
        } as any,
        stage: {} as any,
        timeline: {
          select: vi.fn(),
          selectSingle: vi.fn(),
          toggleSelection: vi.fn(),
          clearSelection: vi.fn(),
          getSelectedIds: () => ({ dialogue_1: true }),
        },
        export: {} as any,
      }}
      stores={{
        document: documentStore,
        playback: playbackStore,
        editor: editorStore,
        validation: validationStore,
      }}
      services={{
        sceneFile: {} as any,
        projectWorkspace: projectWorkspace as any,
      }}
    >
      <ActionInspector
        sceneData={scene}
        selectedActionIds={{ dialogue_1: true }}
        setSelectedIds={vi.fn()}
        updateAction={updateAction}
        updateParam={vi.fn()}
        replaceSourceParams={vi.fn()}
        deleteAction={vi.fn()}
        onClose={vi.fn()}
      />
    </AppProvider>,
  );

  return { ...result, updateAction, projectWorkspace };
}

afterEach(() => {
  delete (window as any).aeonStageryAPI;
  localStorage.clear();
  settingsManager.update({
    gptSovits: {
      apiHost: '127.0.0.1',
      apiPort: 9880,
      rootPath: '',
    },
  });
  showToastMock.mockReset();
});

describe('ActionInspector GPT-SoVITS voice workbench entry', () => {
  it('keeps manual selection and exposes the workbench even before local configuration', () => {
    renderInspector();

    const button = screen.getByRole('button', { name: '语音工作台' });

    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('input')).toBeTruthy();
  });

  it('opens dialogue mode with statement, scene, character and text context', () => {
    const emit = vi.spyOn(eventBus, 'emit');
    const { updateAction } = renderInspector();

    fireEvent.click(screen.getByRole('button', { name: '语音工作台' }));

    expect(emit).toHaveBeenCalledWith('ui:openVoiceWorkbench', {
      mode: 'dialogue',
      statementId: 'dialogue_1',
      sceneId: 'scene_1',
      characterId: 'tomori',
      characterName: undefined,
      voiceProfileId: undefined,
      text: '我想继续唱下去。',
    });
    expect(updateAction).not.toHaveBeenCalled();
  });

  it('exposes the resource browser button on the dialogue voice field and opens asset browser', () => {
    renderInspector();

    const browseButton = screen.getByRole('button', { name: /manual\.wav/ });
    expect(browseButton).toBeTruthy();

    fireEvent.click(browseButton);

    expect(screen.getByRole('dialog', { name: '资源浏览器' })).toBeTruthy();
  });
});

