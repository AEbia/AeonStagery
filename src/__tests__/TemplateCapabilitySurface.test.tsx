/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
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
    expect(screen.getByText('默认对白样式')).toBeTruthy();
    expect(screen.getAllByText('初始角色').length).toBeGreaterThan(0);
    expect(screen.getByText('服装模型导入方式')).toBeTruthy();

    // Deferred capabilities are not surfaced, even though the package provides them.
    expect(screen.queryByText('默认镜头')).toBeNull();
    expect(screen.queryByText('默认光照')).toBeNull();
    expect(screen.queryByText('Push In · Demo')).toBeNull();
    expect(screen.queryByText('Soft Studio · Demo')).toBeNull();
  });
});
