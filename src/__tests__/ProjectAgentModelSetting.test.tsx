// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import { SettingsDialog } from '../ui/SettingsDialog';
import { DEFAULT_SETTINGS, settingsManager } from '../ui/SettingsStore';
import { DEFAULT_AI_MODEL } from '../api/types/ai-prose-authoring';

beforeEach(() => {
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
      dialog: { showOpen: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
      gptSovits: {
        status: vi.fn(async () => ({ success: true, configured: true, state: 'running' })),
        start: vi.fn(async () => ({ success: true })),
        stop: vi.fn(async () => ({ success: true, state: 'stopped' })),
      },
    },
  });
  localStorage.clear();
  settingsManager.update({ aiProse: DEFAULT_SETTINGS.aiProse });
});

describe('project agent model setting UI', () => {
  it('shows an editable project agent model field that inherits the default model', () => {
    const projectWorkspace = {
      getCurrentProject: vi.fn(() => null),
      subscribe: vi.fn(() => () => {}),
    };
    render(
      <AppProvider
        adapters={{ document: {}, playback: {}, camera: {}, character: {}, stage: {}, timeline: {}, export: {} } as never}
        stores={{ document: {}, playback: {}, editor: {}, validation: {} } as never}
        services={{ sceneFile: {}, projectWorkspace } as never}
      >
        <SettingsDialog isOpen onClose={vi.fn()} />
      </AppProvider>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'AI 服务' }));
    const input = screen.getByRole('textbox', { name: 'AI 项目 Agent 模型' }) as HTMLInputElement;
    expect(input.placeholder).toBe(DEFAULT_AI_MODEL);

    fireEvent.change(input, { target: { value: 'agent-model' } });
    expect(settingsManager.get('aiProse').projectAgentModel).toBe('agent-model');

    fireEvent.change(input, { target: { value: '   ' } });
    expect(settingsManager.get('aiProse').projectAgentModel).toBeUndefined();
  });
});
