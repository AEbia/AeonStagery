/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import { SettingsDialog } from '../ui/SettingsDialog';
import { DEFAULT_SETTINGS, settingsManager } from '../ui/SettingsStore';
import type { ProjectState } from '../api/types/project';

function makeProject(): ProjectState {
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
          selectedPresetId: 'old_voice',
          presets: [
            {
              id: 'old_voice',
              name: '旧音色',
              gptWeightsPath: 'D:\\models\\old.ckpt',
              sovitsWeightsPath: 'D:\\models\\old.pth',
              refAudioPath: 'D:\\refs\\old.wav',
              promptText: '旧音色 prompt',
              promptLang: 'zh',
              textLang: 'zh',
              speed: 1,
            },
          ],
        },
      },
    },
  };
}

function installWindowApi(overrides: Record<string, unknown> = {}) {
  Object.defineProperty(window, 'aeonStageryAPI', {
    configurable: true,
    value: {
      updater: {
        getState: vi.fn(async () => ({ state: 'idle', currentVersion: '0.5.0' })),
        onStatus: vi.fn(() => () => {}),
        checkForUpdates: vi.fn(async () => ({ success: true, updateAvailable: false })),
        downloadUpdate: vi.fn(async () => ({ success: true })),
        installUpdate: vi.fn(async () => {}),
      },
      dialog: {
        showOpen: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      },
      gptSovits: {
        status: vi.fn(async () => ({ success: true, configured: true, state: 'running', apiBaseUrl: 'http://127.0.0.1:9880', logs: [] })),
        start: vi.fn(async () => ({ success: true, configured: true, state: 'starting', apiBaseUrl: 'http://127.0.0.1:9880', logs: [] })),
        stop: vi.fn(async () => ({ success: true, state: 'stopped', logs: [] })),
      },
      ...overrides,
    },
  });
}

function renderSettingsDialog(
  project: ProjectState | null = makeProject(),
  projectWorkspaceOverrides: Record<string, unknown> = {},
  serviceOverrides: Record<string, unknown> = {},
) {
  const projectWorkspace = {
    getCurrentProject: vi.fn(() => project),
    subscribe: vi.fn(() => () => {}),
    createProjectAt: vi.fn(),
    openProjectAt: vi.fn(),
    prepareCollaborationProjectAt: vi.fn(),
    updateTemplateConfiguration: vi.fn(),
    updateVoiceGenerationConfiguration: vi.fn(async () => ({ success: true, project, scenePath: 'main.scene.json' })),
    updateVoiceProfiles: vi.fn(async () => ({ success: true, project, scenePath: 'main.scene.json' })),
    prepareTemplateCharacters: vi.fn(),
    ...projectWorkspaceOverrides,
  };

  render(
    <AppProvider
      adapters={{ document: {}, playback: {}, camera: {}, character: {}, stage: {}, timeline: {}, export: {} } as any}
      stores={{ document: {}, playback: {}, editor: {}, validation: {} } as any}
      services={{ sceneFile: {}, projectWorkspace, ...serviceOverrides } as any}
    >
      <SettingsDialog isOpen onClose={vi.fn()} />
    </AppProvider>,
  );

  fireEvent.click(screen.getByRole('tab', { name: '配音服务' }));
  return { projectWorkspace };
}

beforeEach(() => {
  installWindowApi();
  localStorage.clear();
  settingsManager.update({
    aiProse: DEFAULT_SETTINGS.aiProse,
    dialogueTextSpeed: DEFAULT_SETTINGS.dialogueTextSpeed,
    defaultDialogueDurationSeconds: DEFAULT_SETTINGS.defaultDialogueDurationSeconds,
    gptSovits: {
      apiHost: '127.0.0.1',
      apiPort: 9880,
      rootPath: 'D:\\GPT-SoVITS',
    },
  });
});

afterEach(() => {
  delete (window as any).aeonStageryAPI;
  localStorage.clear();
  settingsManager.update({
    aiProse: DEFAULT_SETTINGS.aiProse,
    dialogueTextSpeed: DEFAULT_SETTINGS.dialogueTextSpeed,
    defaultDialogueDurationSeconds: DEFAULT_SETTINGS.defaultDialogueDurationSeconds,
    gptSovits: {
      apiHost: '127.0.0.1',
      apiPort: 9880,
      rootPath: '',
    },
  });
});

describe('SettingsDialog GPT-SoVITS settings', () => {
  it('fetches models from Base URL and supports both dropdown and manual selection', async () => {
    const listModels = vi.fn(async (baseUrl: string) => ({
      success: true,
      models: ['gpt-custom', 'gpt-custom', 'gpt-fast'],
      baseUrl,
    }));
    renderSettingsDialog(null, {}, { aiProse: { transport: { listModels } } });

    fireEvent.click(screen.getByRole('tab', { name: 'AI 服务' }));
    const baseUrlInput = screen.getByRole('textbox', { name: 'AI Base URL' }) as HTMLInputElement;
    expect(baseUrlInput.value).toBe('');
    expect(baseUrlInput.placeholder).toBe('https://api.openai.com/v1');
    const defaultModelInput = screen.getByRole('textbox', { name: 'AI 默认模型' }) as HTMLInputElement;
    expect(defaultModelInput.value).toBe('');
    expect(defaultModelInput.placeholder).toBe('gpt-4o-mini');
    expect(screen.queryByLabelText('AI 目标段大小')).toBeNull();
    expect(screen.queryByText('目标段大小')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '获取模型' }));

    await screen.findByText('已获取 2 个模型');
    expect(listModels).toHaveBeenCalledWith('https://api.openai.com/v1');
    const modelSelect = screen.getByRole('combobox', { name: 'AI 已获取模型' }) as HTMLSelectElement;
    expect(modelSelect.options).toHaveLength(3);

    fireEvent.change(modelSelect, { target: { value: 'gpt-fast' } });
    expect(settingsManager.get('aiProse').defaultModel).toBe('gpt-fast');

    fireEvent.change(screen.getByRole('textbox', { name: 'AI 默认模型' }), { target: { value: 'manual-model' } });
    expect(settingsManager.get('aiProse').defaultModel).toBe('manual-model');

    const effortSelect = screen.getByRole('combobox', { name: 'AI effort' }) as HTMLSelectElement;
    expect([...effortSelect.options].map((option) => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    fireEvent.change(effortSelect, { target: { value: 'max' } });
    expect(settingsManager.get('aiProse').effort).toBe('max');
  });

  it('synchronizes the current provider before testing JSON Output support', async () => {
    const updateProviderConfig = vi.fn();
    const configureProvider = vi.fn(async () => ({ success: true }));
    const probeCapabilities = vi.fn(async () => new Map([
      ['gpt-4o-mini', { jsonOutputSupported: true }],
    ]));
    renderSettingsDialog(null, {}, {
      aiProse: {
        configuration: { updateProviderConfig, probeCapabilities },
        capabilityProbe: { probe: vi.fn() },
        transport: { configureProvider },
      },
    });

    fireEvent.click(screen.getByRole('tab', { name: 'AI 服务' }));
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

    await screen.findByText('已测试 1 个模型 · JSON Output 可用');
    expect(updateProviderConfig).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
    }));
    expect(configureProvider).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
    }));
    expect(probeCapabilities).toHaveBeenCalledOnce();
  });

  it('shows and persists dialogue timing controls from the dialogue tab', async () => {
    renderSettingsDialog();
    fireEvent.click(screen.getByRole('tab', { name: '对白' }));

    const speedSlider = screen.getByRole('slider', { name: '对白文本速度' }) as HTMLInputElement;
    const durationSlider = screen.getByRole('slider', { name: '默认对白时长' }) as HTMLInputElement;

    expect(speedSlider.value).toBe('0.025');
    expect(durationSlider.value).toBe('2');
    expect(screen.getByText('0.025 秒/字')).toBeTruthy();
    expect(screen.getByText('2 秒')).toBeTruthy();

    await act(async () => {
      fireEvent.change(speedSlider, { target: { value: '0.05' } });
      fireEvent.change(durationSlider, { target: { value: '5.5' } });
    });

    await waitFor(() => {
      expect(settingsManager.get('dialogueTextSpeed')).toBe(0.05);
      expect(settingsManager.get('defaultDialogueDurationSeconds')).toBe(5.5);
      expect(JSON.parse(localStorage.getItem('aeonstagery_settings') || '{}')).toMatchObject({
        dialogueTextSpeed: 0.05,
        defaultDialogueDurationSeconds: 5.5,
      });
    });
  });

  it('lists and clears historical collaboration server data from the resources tab', async () => {
    const listSessions = vi.fn(async () => ({
      success: true,
      sessions: [{
        name: 'history-session',
        dataDir: 'D:/userData/collaboration-sessions/history-session',
        sizeBytes: 2048,
        updatedAt: '2026-07-31T00:00:00.000Z',
        hasState: true,
        active: false,
      }],
    }));
    const clearPreviousSessions = vi.fn(async () => ({
      success: true,
      clearedCount: 1,
      skippedActiveCount: 0,
    }));
    installWindowApi({
      collaborationServer: { listSessions, clearPreviousSessions },
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    try {
      renderSettingsDialog();
      fireEvent.click(screen.getByRole('tab', { name: '协作数据' }));

      expect(await screen.findByText('history-session')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '清理未运行的协作房间数据' }));

      expect(await screen.findByText('已清理 1 个未运行的协作服务器目录')).toBeTruthy();
      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('无法恢复原房间'));
      expect(clearPreviousSessions).toHaveBeenCalledTimes(1);
      expect(listSessions).toHaveBeenCalledTimes(2);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('recovers button state and shows a readable message when connection test rejects', async () => {
    const status = vi.fn(async () => {
      throw new Error('IPC disconnected');
    });
    installWindowApi({
      gptSovits: {
        status,
        start: vi.fn(),
        stop: vi.fn(),
      },
    });
    renderSettingsDialog();

    const testButton = screen.getByRole('button', { name: /测试连接/ });
    fireEvent.click(testButton);

    await screen.findByText('GPT-SoVITS 连接测试失败：IPC disconnected');
    expect((testButton as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('状态：error')).toBeTruthy();
  });

  it('keeps legacy project presets read-only and directs authoring to the voice library', () => {
    const updateVoiceGenerationConfiguration = vi.fn();
    renderSettingsDialog(makeProject(), { updateVoiceGenerationConfiguration });

    expect(screen.getByText(/检测到 1 个旧版项目音色配置/)).toBeTruthy();
    expect(screen.queryByDisplayValue('旧音色')).toBeNull();
    expect(screen.queryByRole('button', { name: /添加音色/ })).toBeNull();
    expect(updateVoiceGenerationConfiguration).not.toHaveBeenCalled();
  });

  it('persists explicitly selected model roots for catalog discovery', async () => {
    installWindowApi({
      dialog: {
        showOpen: vi.fn(async () => ({ canceled: false, filePaths: ['D:\\models-extra'] })),
      },
    });
    renderSettingsDialog();
    fireEvent.click(screen.getByRole('button', { name: '添加模型目录' }));

    expect(await screen.findByDisplayValue('D:\\models-extra')).toBeTruthy();
    expect(settingsManager.get('gptSovits').modelRoots).toEqual(['D:\\models-extra']);
  });
});
