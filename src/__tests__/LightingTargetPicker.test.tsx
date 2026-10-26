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
  it.each(['blur', 'post'] as const)('keeps a raw %s character target available when a same-ID layer is added', (effect) => {
    const onChange = vi.fn();
    const { rerender } = render(
      <LightingTargetPicker effect={effect} value="hero" characters={[{ id: 'hero', name: '主角' }]} onChange={onChange} />,
    );
    rerender(
      <LightingTargetPicker effect={effect} value="hero" characters={[{ id: 'hero', name: '主角' }]} environmentLayers={['hero']} onChange={onChange} />,
    );
    const combobox = screen.getByRole('combobox', { name: '作用目标' });
    expect(combobox.textContent).toContain('主角');
    fireEvent.click(combobox);
    expect(screen.getByRole('option', { name: '主角' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('option', { name: /当前对象/ })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['character:hero', 'group:characters'])('preserves a legacy character ID %s without treating it as reference syntax', (id) => {
    const onChange = vi.fn();
    render(<LightingTargetPicker value={id} characters={[{ id, name: '带前缀角色' }, { id: 'hero', name: '主角' }]} onChange={onChange} />);
    const combobox = screen.getByRole('combobox', { name: '作用目标' });
    expect(combobox.textContent).toBe('带前缀角色');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(combobox);
    fireEvent.click(screen.getByRole('option', { name: '主角' }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'character', id: 'hero' });
  });

  it.each([
    [{ kind: 'group', group: 'characters' }, '全部角色'],
    [{ kind: 'group', group: 'environmentLayers' }, '全部环境图层'],
  ] as const)('recognizes structured blur group %s', (target, label) => {
    const onChange = vi.fn();
    render(<LightingTargetPicker effect="blur" value={target} onChange={onChange} />);
    const combobox = screen.getByRole('combobox', { name: '作用目标' });
    expect(combobox.textContent).toContain(label);
    fireEvent.click(combobox);
    expect(screen.getByRole('option', { name: label }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('option', { name: /当前对象/ })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a character named background distinct from the blur environment group', () => {
    const onChange = vi.fn();
    render(<LightingTargetPicker effect="blur" characters={[{ id: 'background', name: '同名角色' }]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: '作用目标' }));
    fireEvent.click(screen.getByRole('option', { name: '同名角色' }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'character', id: 'background' });
    fireEvent.click(screen.getByRole('combobox', { name: '作用目标' }));
    fireEvent.click(screen.getByRole('option', { name: '全部环境图层' }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'group', group: 'environmentLayers' });
  });

  it.each(['blur', 'post'] as const)('disambiguates both inventories when a %s character and layer share an ID', (effect) => {
    const options = buildLightingTargetOptions(undefined, [{ id: 'fog', name: '同名角色' }], [{ layerId: 'fog' }], effect);
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { kind: 'character', id: 'fog' }, targetKind: 'character' }),
      expect.objectContaining({ target: { kind: 'environmentLayer', id: 'fog' }, targetKind: 'environmentLayer' }),
    ]));
    expect(options.some((option) => option.target === 'fog')).toBe(false);
  });

  it('disambiguates a character from the background layer before any environment is authored', () => {
    const options = buildLightingTargetOptions(undefined, ['background']);
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { kind: 'character', id: 'background' }, targetKind: 'character' }),
      expect.objectContaining({ target: { kind: 'environmentLayer', id: 'background' }, targetKind: 'environmentLayer' }),
    ]));
  });

  it('offers individual blur targets while preserving legacy groups and disambiguating reserved names', () => {
    const options = buildLightingTargetOptions({ kind: 'environmentLayer', id: 'background' }, [
      { id: 'hero', name: '主角' },
      { id: 'characters', name: '同名角色' },
    ], [{ layerId: 'fog', displayLabel: '前景雾' }], 'blur');
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'global', label: '全景' }),
      expect.objectContaining({ target: { kind: 'group', group: 'characters' }, label: '全部角色' }),
      expect.objectContaining({ target: { kind: 'group', group: 'environmentLayers' }, label: '全部环境图层' }),
      expect.objectContaining({ target: { kind: 'character', id: 'hero' }, targetKind: 'character' }),
      expect.objectContaining({ target: { kind: 'character', id: 'characters' }, targetKind: 'character' }),
      expect.objectContaining({ target: { kind: 'environmentLayer', id: 'background' }, label: 'background' }),
      expect.objectContaining({ target: { kind: 'environmentLayer', id: 'fog' }, label: 'fog' }),
    ]));
    expect(options.some((option) => option.targetKind === 'current')).toBe(false);
  });

  it('writes an individual environment layer selected for blur', () => {
    const onChange = vi.fn();
    render(<LightingTargetPicker effect="blur" environmentLayers={[{ layerId: 'fog', displayLabel: '前景雾' }]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: '作用目标' }));
    fireEvent.click(screen.getByRole('option', { name: 'fog' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'environmentLayer', id: 'fog' });
  });

  it('builds panorama, character, and environment groups with the reserved background', () => {
    const options = buildLightingTargetOptions('hero', [
      { id: 'hero', name: '主角' },
      { id: 'support', name: 'support' },
    ], [
      { layerId: 'fog', displayLabel: '前景雾' },
    ]);

    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: PANORAMA_TARGET, group: LIGHTING_TARGET_GROUPS.panorama }),
      expect.objectContaining({ target: 'hero', label: '主角', group: LIGHTING_TARGET_GROUPS.character }),
      expect.objectContaining({ target: { kind: 'character', id: 'support' }, label: 'support', group: LIGHTING_TARGET_GROUPS.character }),
      expect.objectContaining({ target: { kind: 'environmentLayer', id: 'background' }, label: 'background', group: LIGHTING_TARGET_GROUPS.environmentLayer }),
      expect.objectContaining({ target: { kind: 'environmentLayer', id: 'fog' }, label: 'fog', group: LIGHTING_TARGET_GROUPS.environmentLayer }),
    ]));
    expect(options.filter((option) => typeof option.target === 'object' && option.target.kind === 'environmentLayer' && option.target.id === 'background')).toHaveLength(1);
  });

  it('uses environment IDs regardless of labels and exposes resources only as supplementary information', () => {
    const options = buildLightingTargetOptions('background', [], [
      { layerId: 'background', displayLabel: '教室.png', sourceFile: 'school/教室.png' },
      { layerId: 'fog', displayLabel: '前景雾', sourceFile: 'effects/fog.png' },
    ]);
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'background', label: 'background', title: 'school/教室.png' }),
      expect.objectContaining({ target: { kind: 'environmentLayer', id: 'fog' }, label: 'fog', title: 'effects/fog.png' }),
    ]));
  });

  it.each(['blur', 'post'] as const)('offers all environment layers and all characters for %s', (effect) => {
    const options = buildLightingTargetOptions(undefined, [], [], effect);
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { kind: 'group', group: 'environmentLayers' }, label: '全部环境图层' }),
      expect.objectContaining({ target: { kind: 'group', group: 'characters' }, label: '全部角色' }),
    ]));
  });

  it('keeps an unknown current target as a disabled option', () => {
    const options = buildLightingTargetOptions('removed-layer', [], []);
    expect(options.at(-1)).toEqual(expect.objectContaining({
      target: 'removed-layer',
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

    expect(onChange).toHaveBeenCalledWith({ kind: 'environmentLayer', id: 'background' });
    expect(onChange).not.toHaveBeenCalledWith('missing');
  });
});
