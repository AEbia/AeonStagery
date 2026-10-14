import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTemplateConfiguration } from '../api/types/project';
import type { useApp } from '../ui/context/AppContext';
import { createInspectorMutations } from '../ui/timeline/inspector/inspectorMutations';
import { buildAvailableDialogueStyles } from '../ui/templates/TemplateCapabilityConfig';
import type { TemplatePackageSummary } from '../services/template-package/TemplatePackageCatalog';

const showToast = vi.fn();
vi.mock('../ui/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

const IMPORTED = {
  id: 'webgal-scss.pure',
  name: 'pure',
  version: '1.0.0',
  installPath: '/templates/webgal-scss.pure',
  replaced: false,
};

interface HarnessOptions {
  enabledTemplateIds?: string[];
  updateResult?: { success: boolean; error?: string };
  summaries?: { id: string; dialogueStyles?: unknown[] }[];
  hasProject?: boolean;
  /** Project exists but carries no  at all. */
  hasTemplates?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const {
    enabledTemplateIds = ['aeonstagery.default'],
    hasTemplates = true,
    updateResult = { success: true },
    summaries = [{ id: 'aeonstagery.default' }, { id: IMPORTED.id }],
    hasProject = true,
  } = options;

  const updateTemplateConfiguration = vi.fn(
    async (_templates: ProjectTemplateConfiguration) => updateResult,
  );
  const refresh = vi.fn(async () => undefined);
  const installWebgalScss = vi.fn(async () => ({ success: true as const, package: IMPORTED }));

  const appContext = {
    services: {
      projectWorkspace: {
        getCurrentProject: () => (hasProject
          ? { metadata: hasTemplates ? { templates: { enabledTemplateIds } } : {} }
          : undefined),
        updateTemplateConfiguration,
        prepareDialogueStyle: vi.fn(async () => ({})),
      },
      templatePackages: {
        getSummaries: () => summaries,
        refresh,
      },
    },
  } as unknown as ReturnType<typeof useApp>;

  const mutations = createInspectorMutations({
    appContext,
    action: { id: 'action-1', semanticType: 'dialogue' } as never,
    actionId: 'action-1',
    actionParams: {},
    sourceParams: {},
    usesSourceParamForm: false,
    sceneData: { meta: {} } as never,
    updateParam: vi.fn(),
    replaceSourceParams: vi.fn(),
  });

  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { aeonStageryAPI: { templates: { installWebgalScss } } };

  return {
    mutations, updateTemplateConfiguration, refresh, installWebgalScss,
    restore: () => { (globalThis as { window?: unknown }).window = previous; },
  };
}

afterEach(() => {
  showToast.mockClear();
});

describe('enableImportedPackage', () => {
  it('keeps existing template precedence when enabling a new package', async () => {
    const summaries: TemplatePackageSummary[] = ['A', 'B', IMPORTED.id].map((id) => ({
      id, name: id, version: '1.0.0', scope: 'user',
      dialogueStyles: id === IMPORTED.id ? [] : [{ id: 'shared', name: id, renderer: 'image-dialogue-v1' }],
    }));
    const enabledTemplateIds = ['B', 'A'];
    const before = buildAvailableDialogueStyles(summaries, enabledTemplateIds);
    const ctx = harness({ enabledTemplateIds, summaries });
    try {
      const result = await ctx.mutations.webGalStyleImport.install({ templateRoot: '/tmp/template' });
      expect(result.ok).toBe(true);
      const written = ctx.updateTemplateConfiguration.mock.calls[0]?.[0];
      expect(written?.enabledTemplateIds).toEqual(['B', 'A', IMPORTED.id]);
      expect(buildAvailableDialogueStyles(summaries, written?.enabledTemplateIds ?? []))
        .toEqual(before);
    } finally {
      ctx.restore();
    }
  });

  it('enables the installed package so its style becomes selectable', async () => {
    const ctx = harness();
    const result = await ctx.mutations.webGalStyleImport!.install({ templateRoot: '/tmp/template' });
    ctx.restore();

    expect(result.ok).toBe(true);
    expect(ctx.refresh).toHaveBeenCalled();
    // The style list is filtered by the project's enabled packages, so an
    // import that only refreshes the catalog stays invisible.
    expect(ctx.updateTemplateConfiguration).toHaveBeenCalledTimes(1);
    const written = ctx.updateTemplateConfiguration.mock.calls[0]?.[0];
    expect(written?.enabledTemplateIds).toEqual(['aeonstagery.default', IMPORTED.id]);
  });

  it('re-saves an already enabled package so the default style is re-materialised', async () => {
    const ctx = harness({ enabledTemplateIds: [IMPORTED.id] });
    const result = await ctx.mutations.webGalStyleImport!.install({ templateRoot: '/tmp/template' });
    ctx.restore();

    // The package was just rewritten on disk. Leaving the enabled list alone is
    // not enough: saving is what re-materialises the project's default
    // `dialoguePresentation`, so new dialogues do not keep the old artwork.
    expect(result.ok).toBe(true);
    expect(ctx.updateTemplateConfiguration).toHaveBeenCalledTimes(1);
    expect(ctx.updateTemplateConfiguration.mock.calls[0]?.[0].enabledTemplateIds)
      .toEqual([IMPORTED.id]);
  });

  it('fills in a default template configuration when the project has none', async () => {
    const ctx = harness({ hasTemplates: false });
    const result = await ctx.mutations.webGalStyleImport!.install({ templateRoot: '/tmp/template' });
    ctx.restore();

    // `metadata.templates` is optional, so the import must not silently skip the
    // enable step — the style would be installed but never offered.
    expect(result.ok).toBe(true);
    expect(ctx.updateTemplateConfiguration).toHaveBeenCalledTimes(1);
    const written = ctx.updateTemplateConfiguration.mock.calls[0]?.[0];
    expect(written?.enabledTemplateIds).toEqual(['aeonstagery.default', IMPORTED.id]);
  });

  it('surfaces a failed project write without failing the import', async () => {
    const ctx = harness({ updateResult: { success: false, error: 'No active project' } });
    const result = await ctx.mutations.webGalStyleImport!.install({ templateRoot: '/tmp/template' });
    ctx.restore();

    // The package is on disk, so the import did happen; only the project-level
    // enablement failed.
    expect(result.ok).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('未能在当前项目启用'),
      'error',
    );
  });

  it('does nothing when no project is open', async () => {
    const ctx = harness({ hasProject: false });
    const result = await ctx.mutations.webGalStyleImport!.install({ templateRoot: '/tmp/template' });
    ctx.restore();

    expect(result.ok).toBe(true);
    expect(ctx.updateTemplateConfiguration).not.toHaveBeenCalled();
  });
});
