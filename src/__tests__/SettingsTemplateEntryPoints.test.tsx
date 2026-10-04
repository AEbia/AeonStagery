// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppProvider } from '../ui/context/AppContext';
import { SettingsDialog } from '../ui/SettingsDialog';
import { findSettingsCategories, isSettingsDialogTab, SETTINGS_CATEGORIES } from '../ui/settingsNavigation';

beforeEach(() => {
  Object.defineProperty(window, 'aeonStageryAPI', {
    configurable: true,
    value: {
      updater: {
        getState: vi.fn(async () => ({ state: 'idle', currentVersion: '0.7.7' })),
        onStatus: vi.fn(() => () => {}),
        checkForUpdates: vi.fn(async () => ({ success: true, updateAvailable: false })),
        downloadUpdate: vi.fn(async () => ({ success: true })),
        installUpdate: vi.fn(async () => {}),
      },
      dialog: { showOpen: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    },
  });
  localStorage.clear();
});

describe('settings template entry point', () => {
  it('keeps 项目模板 registered as a settings category', () => {
    const category = SETTINGS_CATEGORIES.find((candidate) => candidate.id === 'templates');
    expect(category?.label).toBe('项目模板');
    expect(isSettingsDialogTab('templates')).toBe(true);
    expect(findSettingsCategories('模板').map((candidate) => candidate.id)).toContain('templates');
  });

  it('renders the injected template panel on the templates tab', () => {
    render(
      <AppProvider
        adapters={{ document: {}, playback: {}, camera: {}, character: {}, stage: {}, timeline: {}, export: {} } as never}
        stores={{ document: {}, playback: {}, editor: {}, validation: {} } as never}
        services={{ sceneFile: {}, projectWorkspace: { getCurrentProject: () => null, subscribe: () => () => {} } } as never}
      >
        <SettingsDialog
          isOpen
          initialTab="templates"
          onClose={vi.fn()}
          templateContent={<div>模板能力配置测试面板</div>}
        />
      </AppProvider>,
    );

    expect(screen.getByRole('tab', { name: '项目模板' })).toBeTruthy();
    expect(screen.getByText('模板能力配置测试面板')).toBeTruthy();
  });
});
