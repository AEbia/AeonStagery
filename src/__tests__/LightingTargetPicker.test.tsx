/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  LIGHTING_TARGET_GROUPS,
  LightingTargetPicker,
  PANORAMA_TARGET,
  buildLightingTargetOptions,
} from '../ui/timeline/LightingTargetPicker';

afterEach(cleanup);

describe('lighting target picker', () => {
  it('builds panorama, character, and environment groups with the reserved background', () => {
    const options = buildLightingTargetOptions('hero', [
      { id: 'hero', name: '主角' },
      { id: 'support', name: 'support' },
    ], [
      { layerId: 'fog', displayLabel: '前景雾' },
    ]);

    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: PANORAMA_TARGET, group: LIGHTING_TARGET_GROUPS.panorama }),
      expect.objectContaining({ value: 'hero', label: '主角 (hero)', group: LIGHTING_TARGET_GROUPS.character }),
      expect.objectContaining({ value: 'support', label: 'support', group: LIGHTING_TARGET_GROUPS.character }),
      expect.objectContaining({ value: 'background', label: '背景', group: LIGHTING_TARGET_GROUPS.environmentLayer }),
      expect.objectContaining({ value: 'fog', label: '前景雾', group: LIGHTING_TARGET_GROUPS.environmentLayer }),
    ]));
    expect(options.filter((option) => option.value === 'background')).toHaveLength(1);
  });

  it('keeps an unknown current target as a disabled option', () => {
    const options = buildLightingTargetOptions('removed-layer', [], []);
    expect(options.at(-1)).toEqual(expect.objectContaining({
      value: 'removed-layer',
      label: '当前对象 (removed-layer)',
      disabled: true,
      targetKind: 'current',
    }));
  });

  it('renders grouped options and preserves an unknown selection through the shared combobox', () => {
    const onChange = vi.fn();
    render(
      <LightingTargetPicker
        id="post-target"
        value="missing-character"
        characters={[{ id: 'hero', name: '主角' }]}
        environmentLayers={[{ layerId: 'mist', displayLabel: '薄雾' }]}
        onChange={onChange}
      />,
    );

    const combobox = screen.getByRole('combobox', { name: '作用目标' });
    expect(combobox.textContent).toContain('当前对象 (missing-character)');

    fireEvent.click(combobox);
    expect(screen.getAllByText('全景').length).toBeGreaterThan(0);
    expect(screen.getAllByText('角色').length).toBeGreaterThan(0);
    expect(screen.getAllByText('环境图层').length).toBeGreaterThan(0);
    const current = screen.getByRole('option', { name: '当前对象 (missing-character)' });
    expect(current.getAttribute('aria-disabled')).toBe('true');

    fireEvent.keyDown(combobox, { key: 'Home' });
    fireEvent.keyDown(combobox, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('panorama');
  });

  it('skips the disabled current option during keyboard navigation', () => {
    const onChange = vi.fn();
    render(<LightingTargetPicker value="missing" onChange={onChange} />);
    const combobox = screen.getByRole('combobox', { name: '作用目标' });
    fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    fireEvent.keyDown(combobox, { key: 'End' });
    fireEvent.keyDown(combobox, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('background');
    expect(onChange).not.toHaveBeenCalledWith('missing');
  });
});
