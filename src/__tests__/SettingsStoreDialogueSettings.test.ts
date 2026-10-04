// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

const SETTINGS_STORAGE_KEY = 'aeonstagery_settings';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('dialogue settings persistence', () => {
  it('clears the legacy built-in glass signature while preserving custom signature text', async () => {
    vi.resetModules();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      dialogueSignatureText1: 'an',
      dialogueSignatureText2: 'sy',
    }));

    const { settingsManager } = await import('../ui/SettingsStore');

    expect(settingsManager.get('dialogueSignatureText1')).toBe('');
    expect(settingsManager.get('dialogueSignatureText2')).toBe('');

    vi.resetModules();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      dialogueSignatureText1: 'Rin',
      dialogueSignatureText2: 'Studio',
    }));
    const customSettings = await import('../ui/SettingsStore');

    expect(customSettings.settingsManager.get('dialogueSignatureText1')).toBe('Rin');
    expect(customSettings.settingsManager.get('dialogueSignatureText2')).toBe('Studio');
  });

  it('initializes dialogue speed from legacy typewriterSpeed when the new field is missing', async () => {
    vi.resetModules();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ typewriterSpeed: 0.08 }));

    const { settingsManager } = await import('../ui/SettingsStore');

    expect(settingsManager.get('dialogueTextSpeed')).toBe(0.08);
  });

  it('falls back to defaults for invalid persisted dialogue timing values', async () => {
    vi.resetModules();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      dialogueTextSpeed: 'fast',
      defaultDialogueDurationSeconds: null,
    }));

    const { DEFAULT_SETTINGS, settingsManager } = await import('../ui/SettingsStore');

    expect(settingsManager.get('dialogueTextSpeed')).toBe(DEFAULT_SETTINGS.dialogueTextSpeed);
    expect(settingsManager.get('defaultDialogueDurationSeconds')).toBe(DEFAULT_SETTINGS.defaultDialogueDurationSeconds);
  });

  it('normalizes dialogue timing settings before saving', async () => {
    vi.resetModules();
    const {
      DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE,
      DEFAULT_SETTINGS,
      DIALOGUE_TEXT_SPEED_SECONDS_RANGE,
      settingsManager,
    } = await import('../ui/SettingsStore');

    settingsManager.update({
      dialogueTextSpeed: 1,
      defaultDialogueDurationSeconds: 0.1,
    });

    expect(settingsManager.get('dialogueTextSpeed')).toBe(DIALOGUE_TEXT_SPEED_SECONDS_RANGE.max);
    expect(settingsManager.get('defaultDialogueDurationSeconds')).toBe(DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE.min);

    settingsManager.update({
      dialogueTextSpeed: Number.NaN as never,
      defaultDialogueDurationSeconds: 'long' as never,
    });

    expect(settingsManager.get('dialogueTextSpeed')).toBe(DEFAULT_SETTINGS.dialogueTextSpeed);
    expect(settingsManager.get('defaultDialogueDurationSeconds')).toBe(DEFAULT_SETTINGS.defaultDialogueDurationSeconds);
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}')).toMatchObject({
      dialogueTextSpeed: DEFAULT_SETTINGS.dialogueTextSpeed,
      defaultDialogueDurationSeconds: DEFAULT_SETTINGS.defaultDialogueDurationSeconds,
    });
  });
});

describe('workbench authoring settings persistence', () => {
  it('defaults invalid persisted layout and flow modes conservatively', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      workbenchTimelineLayoutMode: 'wide',
      workbenchDialogueFlowMode: 'always',
    }));

    const { settingsManager } = await import('../ui/SettingsStore');

    expect(settingsManager.get('workbenchTimelineLayoutMode')).toBe('tracks');
    expect(settingsManager.get('workbenchDialogueFlowMode')).toBe('manual');
  });

  it('loads and saves the selected layout and flow modes', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      workbenchTimelineLayoutMode: 'list',
      workbenchDialogueFlowMode: 'auto',
    }));

    const { settingsManager } = await import('../ui/SettingsStore');

    expect(settingsManager.get('workbenchTimelineLayoutMode')).toBe('list');
    expect(settingsManager.get('workbenchDialogueFlowMode')).toBe('auto');

    settingsManager.update({
      workbenchTimelineLayoutMode: 'tracks',
      workbenchDialogueFlowMode: 'manual',
    });
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}')).toMatchObject({
      workbenchTimelineLayoutMode: 'tracks',
      workbenchDialogueFlowMode: 'manual',
    });
  });
});

describe('appearance settings persistence', () => {
  it('maps the retired pink theme to system appearance on load', async () => {
    vi.resetModules();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'pink' }));

    const { settingsManager } = await import('../ui/SettingsStore');

    expect(settingsManager.get('theme')).toBe('system');
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}').theme).toBe('system');
  });
});
