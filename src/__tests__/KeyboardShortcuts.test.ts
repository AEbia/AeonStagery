/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS } from '../ui/shortcuts/defaults';
import { ShortcutSettingsPanel } from '../ui/shortcuts/ShortcutSettingsPanel';
import {
  addShortcutBinding,
  findShortcutConflicts,
  formatShortcutBinding,
  getEffectiveShortcutBindings,
  replaceConflictingShortcutBindings,
  resolveShortcutCommandId,
} from '../ui/shortcuts/shortcutUtils';
import type { KeyboardShortcutsSettings } from '../ui/shortcuts/types';

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe('Premiere style keyboard shortcuts', () => {
  afterEach(() => {
    cleanup();
  });

  it('resolves Space to playback on editing surfaces', () => {
    const commandId = resolveShortcutCommandId(
      keydown({ key: ' ', code: 'Space' }),
      DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
      'timeline',
    );

    expect(commandId).toBe('app.playPause');
  });

  it('keeps Premiere-style timeline commands scoped to timeline surfaces', () => {
    const marker = keydown({ key: 'm', code: 'KeyM' });

    expect(resolveShortcutCommandId(marker, DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS, 'timeline')).toBe('timeline.addMarker');
    expect(resolveShortcutCommandId(marker, DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS, 'app')).toBeNull();
  });

  it('keeps R as the default stage reset shortcut across editing surfaces', () => {
    const reset = keydown({ key: 'r', code: 'KeyR' });

    expect(resolveShortcutCommandId(reset, DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS, 'app')).toBe('stage.resetView');
    expect(resolveShortcutCommandId(reset, DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS, 'stage')).toBe('stage.resetView');
  });

  it('applies user overrides before default bindings', () => {
    const settings = addShortcutBinding(
      DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
      'timeline.splitSelection',
      { code: 'KeyB', key: 'b' },
    );

    expect(resolveShortcutCommandId(keydown({ key: 'b', code: 'KeyB' }), settings, 'timeline')).toBe('timeline.splitSelection');
    expect(getEffectiveShortcutBindings(settings, 'timeline.splitSelection').map(formatShortcutBinding)).toContain('B');
  });

  it('allows clearing undo without resolving the default binding', () => {
    const settings: KeyboardShortcutsSettings = {
      ...DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
      overrides: {
        ...DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS.overrides,
        'app.undo': [],
      },
    };

    expect(resolveShortcutCommandId(
      keydown({ key: 'z', code: 'KeyZ', ctrlKey: true }),
      settings,
      'app',
    )).toBeNull();
  });

  it('reports and replaces conflicts within overlapping scopes', () => {
    const binding = { code: 'Space', key: ' ' };
    const conflicts = findShortcutConflicts(
      DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
      'timeline.splitSelection',
      binding,
    );

    expect(conflicts.map((conflict) => conflict.commandId)).toContain('app.playPause');

    const next = replaceConflictingShortcutBindings(
      DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
      'timeline.splitSelection',
      binding,
    );

    expect(resolveShortcutCommandId(keydown({ key: ' ', code: 'Space' }), next, 'timeline')).toBe('timeline.splitSelection');
    expect(getEffectiveShortcutBindings(next, 'app.playPause')).toEqual([]);
  });

  it('filters shortcut settings by formatted binding text', () => {
    const saveBinding = formatShortcutBinding(
      getEffectiveShortcutBindings(DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS, 'app.save')[0],
    );

    render(React.createElement(ShortcutSettingsPanel, {
      value: DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
      onChange: vi.fn(),
    }));

    fireEvent.change(screen.getByLabelText('搜索快捷键和鼠标操作'), {
      target: { value: saveBinding.toLowerCase() },
    });

    expect(screen.getByText('保存场景')).toBeTruthy();
    expect(screen.queryByText('播放 / 停止')).toBeNull();
  });

  it('shows searchable mouse shortcuts in shortcut settings', () => {
    render(React.createElement(ShortcutSettingsPanel, {
      value: DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
      onChange: vi.fn(),
    }));

    expect(screen.getByText('鼠标操作')).toBeTruthy();
    expect(screen.getByText('Alt + 滚轮')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('搜索快捷键和鼠标操作'), {
      target: { value: '滚轮' },
    });

    expect(screen.getByText('缩放时间线')).toBeTruthy();
    expect(screen.getByText('缩放舞台视图')).toBeTruthy();
    expect(screen.queryByText('保存场景')).toBeNull();
  });
});
