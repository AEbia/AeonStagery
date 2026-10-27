import { describe, expect, it } from 'vitest';
import { describeProjectAgentDialogueStyles } from '../services/project-agent-service/ProjectAgentDialogueStyles';
import { createLoadedTemplatePackage } from '../services/template-package/TemplatePackageLoader';
import defaultManifest from '../templates/default/manifest.v2.json';

const builtin = createLoadedTemplatePackage(defaultManifest, {
  scope: 'builtin', packageRoot: '/private/templates/default', manifestPath: '/private/templates/default/manifest.v2.json',
});

describe('Project Agent dialogue styles', () => {
  it('resolves enabled template defaults and lists styles without exposing package asset paths', () => {
    const result = describeProjectAgentDialogueStyles({ enabledTemplateIds: ['aeonstagery.default'] }, [builtin]);
    expect(result.defaultStyleId).toBe('immersive-subtitle');
    expect(result.availableStyles).toContainEqual({
      id: 'immersive-subtitle', name: '沉浸字幕', renderer: 'image-dialogue-v1', materializationRequired: true,
    });
    expect(JSON.stringify(result)).not.toContain('/private/');
    expect(JSON.stringify(result)).not.toContain('textbox.svg');
  });

  it('excludes disabled template styles and retains a project-owned snapshot without a catalog', () => {
    const result = describeProjectAgentDialogueStyles({
      enabledTemplateIds: [],
      dialoguePresentation: {
        renderer: 'image-dialogue-v1', styleId: 'project.custom',
        textbox: { image: 'images/box.png', x: 0, y: 760, width: 1920 },
        text: { x: 100, y: 800, maxWidth: 1720 },
      },
    }, [builtin]);
    expect(result.defaultStyleId).toBe('project.custom');
    expect(result.availableStyles.map((style) => style.id)).toEqual(['glass', 'minimal', 'classic', 'project.custom']);
    expect(result.availableStyles.at(-1)?.materializationRequired).toBe(false);
  });

  it('honors project overrides and deduplicates built-in renderer styles', () => {
    const result = describeProjectAgentDialogueStyles({
      enabledTemplateIds: ['aeonstagery.default'], defaults: { dialogueStyleId: 'minimal' },
    }, [builtin]);
    expect(result.defaultStyleId).toBe('minimal');
    expect(result.availableStyles.filter((style) => style.id === 'minimal')).toHaveLength(1);
    expect(result.availableStyles.find((style) => style.id === 'minimal')?.materializationRequired).toBe(false);
  });
});
