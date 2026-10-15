/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TemplatePackageSummary } from '../services/template-package';
import { TemplateProjectConfigDialog } from '../ui/templates/TemplateProjectConfigDialog';

// The package deliberately declares camera/lighting presets and defaults: they are
// deferred (半成品) capabilities, so the settings panel must not surface them even
// when a template package provides them.
const templatePackages: TemplatePackageSummary[] = [{
  id: 'template.demo',
  name: 'Demo',
  version: '1.0.0',
  scope: 'project',
  dialogueStyles: [{ id: 'glass', name: 'Glass', renderer: 'image-dialogue-v1' }],
  characterPresets: [{ id: 'hero', name: 'Hero', variantCount: 1 }],
  cameraPresets: [{ id: 'push_in', name: 'Push In' }],
  lightingPresets: [{ id: 'soft_studio', name: 'Soft Studio' }],
  defaults: {
    dialogueStyleId: 'glass',
    cameraPresetId: 'push_in',
    lightingPresetId: 'soft_studio',
  },
}];

describe('template settings panel capability surface', () => {
  it('allows disabling the last package and preserves the empty selection on catalog refresh', async () => {
    const onSave = vi.fn();
    const props = { embedded: true, isOpen: true, templatePackages, value: { enabledTemplateIds: ['template.demo'] }, onClose: vi.fn(), onSave };
    const { rerender } = render(<TemplateProjectConfigDialog {...props} />);
    const checkbox = screen.getByRole('checkbox', { name: '启用模板 Demo' }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    rerender(<TemplateProjectConfigDialog {...props} templatePackages={[...templatePackages]} />);
    expect(checkbox.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ enabledTemplateIds: [] }), {}));
  });

  it('offers deletion for external packages, reports failure, and keeps the package selectable', async () => {
    const external = { ...templatePackages[0], packageRoot: '/library/templates/demo' };
    const builtin = { ...external, id: 'builtin', name: 'Builtin', scope: 'builtin' as const };
    const onDeletePackage = vi.fn(async () => { throw new Error('目录被占用'); });
    render(<TemplateProjectConfigDialog embedded isOpen templatePackages={[external, builtin]} value={{ enabledTemplateIds: [] }} onClose={vi.fn()} onSave={vi.fn()} onDeletePackage={onDeletePackage} />);
    expect(screen.queryByRole('button', { name: '删除模板包 Builtin' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '删除模板包 Demo' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目录被占用'));
    expect(onDeletePackage).toHaveBeenCalledWith(external);
    expect((screen.getByRole('checkbox', { name: '启用模板 Demo' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('reports save failures without losing the unchecked selection', async () => {
    render(<TemplateProjectConfigDialog embedded isOpen templatePackages={templatePackages} value={{ enabledTemplateIds: [] }} onClose={vi.fn()} onSave={async () => { throw new Error('写入失败'); }} />);
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('写入失败'));
    expect((screen.getByRole('checkbox', { name: '启用模板 Demo' }) as HTMLInputElement).checked).toBe(false);
  });

  it('keeps the finished capabilities and omits the deferred camera/lighting defaults', () => {
    render(
      <TemplateProjectConfigDialog
        embedded
        isOpen
        templatePackages={templatePackages}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    // Finished capabilities stay reachable.
    expect(screen.getByRole('checkbox', { name: '启用模板 Demo' })).toBeTruthy();
    // Dialogue defaults have a dedicated settings category.
    expect(screen.queryByText('默认对白样式')).toBeNull();
    expect(screen.getAllByText('初始角色').length).toBeGreaterThan(0);
    expect(screen.getByText('服装模型导入方式')).toBeTruthy();

    // Deferred capabilities are not surfaced, even though the package provides them.
    expect(screen.queryByText('默认镜头')).toBeNull();
    expect(screen.queryByText('默认光照')).toBeNull();
    expect(screen.queryByText('Push In · Demo')).toBeNull();
    expect(screen.queryByText('Soft Studio · Demo')).toBeNull();
  });
});
