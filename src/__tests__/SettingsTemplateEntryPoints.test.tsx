// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TemplatePackageCatalog } from '../services/template-package/TemplatePackageCatalog';
import { SEMANTIC_BUILTIN_TEMPLATE_PACKAGE } from '../services/template-package/BuiltinTemplatePackage';
import { DEFAULT_SETTINGS, settingsManager } from '../ui/SettingsStore';
import { AppProvider } from '../ui/context/AppContext';
import { SettingsDialog } from '../ui/SettingsDialog';
import { findSettingsCategories, isSettingsDialogTab, SETTINGS_CATEGORIES } from '../ui/settingsNavigation';
import { IconDialogue } from '../ui/icons';

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

afterEach(() => {
  cleanup();
  settingsManager.set('dialogueEntranceAnimation', DEFAULT_SETTINGS.dialogueEntranceAnimation);
  settingsManager.set('dialogueFontSize', DEFAULT_SETTINGS.dialogueFontSize);
});

describe('settings template entry point', () => {
  it('groups dialogue defaults, timing and animation in the dialogue category', async () => {
    let project = { metadata: { templates: { enabledTemplateIds: ['aeonstagery.default'], defaults: { dialogueStyleId: 'glass' } } } };
    const updateTemplateConfiguration = vi.fn(async (templates) => {
      project = { metadata: { templates } };
      return { success: true, project };
    });
    render(
      <AppProvider
        adapters={{ document: {}, playback: {}, camera: {}, character: {}, stage: {}, timeline: {}, export: {} } as never}
        stores={{ document: {}, playback: {}, editor: {}, validation: {} } as never}
        services={{ projectWorkspace: { getCurrentProject: () => project, subscribe: () => () => {}, updateTemplateConfiguration }, templatePackages: new TemplatePackageCatalog([SEMANTIC_BUILTIN_TEMPLATE_PACKAGE]) } as never}
      >
        <SettingsDialog isOpen initialTab="dialogue" onClose={vi.fn()} />
      </AppProvider>,
    );
    expect(screen.getByRole('tab', { name: '对白' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('默认对白时长')).toBeTruthy();
    expect(screen.getByText('对白文本速度')).toBeTruthy();
    const fontSize = screen.getByRole('slider', { name: '对白字体大小' });
    fireEvent.change(fontSize, { target: { value: '64' } });
    expect(settingsManager.get('dialogueFontSize')).toBe(64);
    expect(fontSize.getAttribute('aria-valuetext')).toBe('64 像素');
    expect(findSettingsCategories('字号').map((category) => category.id)).toContain('dialogue');
    const entrance = screen.getByRole('switch', { name: '文本框入场动画' });
    fireEvent.click(entrance);
    expect(settingsManager.get('dialogueEntranceAnimation')).toBe(false);
    fireEvent.click(screen.getByRole('combobox', { name: '默认对白样式' }));
    expect(screen.getByRole('option', { name: '玻璃' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: '粉色名牌' }));
    await waitFor(() => expect(updateTemplateConfiguration).toHaveBeenCalledWith(expect.objectContaining({ defaults: { dialogueStyleId: 'pink-nameplate' } })));
    fireEvent.click(screen.getByRole('tab', { name: '音频' }));
    expect(screen.queryByText('默认对白时长')).toBeNull();
  });

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

  it('registers a dedicated dialogue icon for the dialogue category', () => {
    const category = SETTINGS_CATEGORIES.find((candidate) => candidate.id === 'dialogue');
    expect(category?.icon).toBe('dialogue');
    const { container } = render(<IconDialogue data-testid="dialogue-icon" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.querySelectorAll('path').length).toBeGreaterThanOrEqual(1);
  });
});
