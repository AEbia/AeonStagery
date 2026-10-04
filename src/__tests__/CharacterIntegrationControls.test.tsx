/** @vitest-environment jsdom */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CharacterIntegrationControls } from '../ui/timeline/CharacterIntegrationControls';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { resolveVisualStateAtTime } from '../services/visual-authoring/VisualStateResolver';

const initial = { scope: 'object', target: 'hero', slot: 'integration', mode: 'set', recipeId: 'builtin:integration-soft', intensity: 0.82, blend: 0.36, contamination: 0.18 };
const targets = [{ value: 'hero', label: 'Hero' }];
afterEach(cleanup);

function compile(params: Record<string, unknown>) {
  const document = sceneDocumentCodec.parseAndValidate(JSON.parse(JSON.stringify({
    schemaVersion: 4, sceneId: 'integration', meta: { title: 'Integration', characters: [{ id: 'hero', name: 'Hero', model: 'hero.json' }] },
    statements: [{ id: 'integration', time: 0, type: 'visualStyle', params }],
  })));
  const compiled = sceneStatementCompiler.compile(document);
  return { action: compiled.actions[0], state: resolveVisualStateAtTime({ sceneId: document.sceneId, meta: document.meta, timeline: compiled.actions } as any, 0) };
}

function mount(params: Record<string, unknown> = initial) {
  const changed = vi.fn();
  function Editor() {
    const [value, setValue] = useState(params);
    return <CharacterIntegrationControls params={value} targets={targets} onChange={(next) => { changed(next); setValue(next); }} />;
  }
  render(<Editor />);
  return changed;
}
describe('character integration editing', () => {
  it('always uses automatic four-corner sampling without palette or manual color controls', () => {
    const changed = mount();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByText('自动采样角色四周的环境图层，生成四色渐变。')).toBeNull();
    expect(screen.queryByRole('combobox', { name: '配色' })).toBeNull();
    expect(screen.queryByText('跟随背景')).toBeNull();
    expect(screen.queryByText('指定颜色')).toBeNull();
    expect(document.querySelector('input[type=color]')).toBeNull();
    expect(screen.queryByText('风格微调')).toBeNull();
    expect(screen.queryByText('融入度')).toBeNull();
    expect(screen.getByRole('spinbutton', { name: '亮度' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '染色强度' }), { key: 'ArrowUp' });
    const next = changed.mock.lastCall![0];
    expect(next).toMatchObject({ blend: 0.36, contamination: 0.18 });
    expect(compile(next).action.params.intensity).toBeCloseTo(0.87);

    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '亮度' }), { key: 'ArrowUp' });
    expect(changed.mock.lastCall![0].brightness).toBeCloseTo(0.05);
    expect(compile(changed.mock.lastCall![0]).state.compositeTargets.hero?.slots.integration?.latched?.semanticOverride?.brightness).toBeCloseTo(0.05);
  });

  it('edits the effective override without rewriting old source colors on open', () => {
    const oldColors = { color: '#654321', colorStops: ['#222222', '#333333'] };
    const changed = mount({ ...initial, color: '#123456', semanticOverride: { intensity: 0.2, ...oldColors } });
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('spinbutton', { name: '染色强度' }).getAttribute('aria-valuenow')).toBe('0.2');
    expect(screen.getByRole('spinbutton', { name: '冷暖' }).getAttribute('aria-valuenow')).toBe('0');
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '染色强度' }), { key: 'ArrowUp' });
    const next = changed.mock.lastCall![0];
    expect(next.semanticOverride).toEqual({ intensity: 0.25, ...oldColors });
    expect(next.intensity).toBe(0.82);
    expect(compile(next).state.compositeTargets.hero?.slots.integration?.latched?.semanticOverride?.intensity).toBe(0.25);
  });

  it('does not render a preset selector and preserves old recipeId', () => {
    const changed = mount({ ...initial, recipeId: 'builtin:default-integration' });
    expect(screen.queryByRole('combobox', { name: '效果预设' })).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(['set', 'modulate'])('preserves single color through %s compilation', (mode) => {
    const params: Record<string, unknown> = { ...initial, mode, color: '#2468ac', durationSeconds: 1 };
    if (mode === 'modulate') delete params.recipeId;
    expect(compile(params).action.params.color).toBe('#2468ac');
  });

  it('shows only role and transition for reset, and no preset for modulation', () => {
    const { rerender } = render(<CharacterIntegrationControls params={{ target: 'hero' }} targets={targets} mode="reset" onChange={vi.fn()} />);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
    rerender(<CharacterIntegrationControls params={{ target: 'hero' }} targets={targets} mode="modulate" onChange={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: '效果预设' })).toBeNull();
    expect(screen.getByRole('combobox', { name: '颜色混合' })).toBeTruthy();
  });
});
