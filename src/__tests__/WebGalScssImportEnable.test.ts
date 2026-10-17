import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTemplateConfiguration } from '../api/types/project';
import { SCENE_SCHEMA_VERSION, type DialogueImagePresentation } from '../api/types/semantic-scene';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';
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
  replaced?: boolean;
  semanticAuthoring?: SemanticAuthoringApplicationService;
  previousPresentation?: DialogueImagePresentation;
  previousStyleId?: string;
  preparedPresentation?: DialogueImagePresentation;
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
  const installWebgalScss = vi.fn(async () => ({ success: true as const, package: { ...IMPORTED, replaced: options.replaced ?? false } }));
  const prepareDialogueStyle = vi.fn(async () => ({ dialoguePresentation:options.preparedPresentation }));

  const appContext = {
    services: {
      projectWorkspace: {
        getCurrentProject: () => (hasProject
          ? { metadata: hasTemplates ? { templates: {
            enabledTemplateIds, dialoguePresentation:options.previousPresentation,
            defaults:{ dialogueStyleId:options.previousStyleId },
          } } : {} }
          : undefined),
        updateTemplateConfiguration,
        prepareDialogueStyle,
      },
      templatePackages: {
        getSummaries: () => summaries,
        refresh,
      },
      semanticAuthoring:options.semanticAuthoring,
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
    mutations, updateTemplateConfiguration, refresh, installWebgalScss, prepareDialogueStyle,
    restore: () => { (globalThis as { window?: unknown }).window = previous; },
  };
}

afterEach(() => {
  showToast.mockClear();
});

describe('enableImportedPackage', () => {
  it.each([false, true])('replaces existing dialogue snapshots and compiled artwork in one undoable edit (legacy: %s)', async (legacy) => {
    const styleId = `${IMPORTED.id}.dialogue`;
    const old: DialogueImagePresentation = {
      renderer:'image-dialogue-v1', ...(legacy ? {} : { styleId }),
      textbox:{ image:'images/old.svg', x:0, y:700, width:1920, height:300 },
      text:{ x:50, y:750, maxWidth:1800 },
    };
    const updated: DialogueImagePresentation = {
      ...old,
      styleId,
      namebox:{ image:'images/pink.svg', x:960, y:650, width:300, minHeight:80, anchorX:0.5 },
    };
    const store = new DocumentStore();
    const runtime = { projectPreparedScene:vi.fn(async () => undefined) };
    const coordinator = new SemanticDocumentCoordinator(store,
      new SemanticScenePipeline({ resolveAsset:async (source) => `asset://localhost/project/${source}` }), runtime);
    await coordinator.applyDocument({
      schemaVersion:SCENE_SCHEMA_VERSION, sceneId:'overwrite', meta:{ title:'Overwrite' },
      statements:[
        { id:'old-a', type:'dialogue', time:0, params:{ text:'A', durationSeconds:1, presentation:old } },
        { id:'old-b', type:'dialogue', time:1, params:{ text:'B', durationSeconds:1, presentation:old } },
        { id:'other', type:'dialogue', time:2, params:{ text:'Other', durationSeconds:1, presentation:{ ...old, styleId:'other-style' } } },
      ],
    });
    const before = store.getCurrentSceneDocumentSnapshot();
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);
    const ctx = harness({
      replaced:true, enabledTemplateIds:[IMPORTED.id], semanticAuthoring:authoring,
      previousPresentation:old, previousStyleId:styleId, preparedPresentation:updated,
      summaries:[{ id:IMPORTED.id, dialogueStyles:[{ id:styleId, renderer:'image-dialogue-v1' }] }],
    });
    try {
      const result = await ctx.mutations.webGalStyleImport.install({ templateRoot:'/tmp/template', replacePackageId:IMPORTED.id });
      expect(result.ok).toBe(true);
      const after = store.getCurrentSceneDocumentSnapshot()!;
      expect(after.statements[0].params).toMatchObject({ text:'A', presentation:updated });
      expect(after.statements[1].params).toMatchObject({ text:'B', presentation:updated });
      expect(after.statements[2]).toEqual(before!.statements[2]);
      expect(store.getCompiledSceneSnapshot()?.actions.find((action) => action.source.statementId === 'old-a')?.params)
        .toMatchObject({ presentation:{ namebox:{ image:expect.stringContaining('pink.svg') } } });
      expect(result.message).toContain('2');
      expect(ctx.prepareDialogueStyle).toHaveBeenCalledWith(styleId);
      expect(runtime.projectPreparedScene).toHaveBeenCalledTimes(2);
      expect(await authoring.undo()).toBe(true);
      expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
      expect(await authoring.undo()).toBe(false);
      expect(await authoring.redo()).toBe(true);
      expect(store.getCurrentSceneDocumentSnapshot()).toEqual(after);
    } finally {
      ctx.restore();
    }
  });

  it('reports a scene refresh failure after a successful package replacement', async () => {
    const store = new DocumentStore();
    const coordinator = new SemanticDocumentCoordinator(store,
      new SemanticScenePipeline({ resolveAsset:async (source) => source }),
      { projectPreparedScene:vi.fn(async () => undefined) });
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);
    vi.spyOn(authoring, 'refreshDialogueStyles').mockRejectedValueOnce(new Error('Projection failed'));
    const presentation: DialogueImagePresentation = {
      renderer:'image-dialogue-v1', styleId:IMPORTED.id,
      textbox:{ image:'images/panel.svg', x:0, y:700, width:1920, height:300 },
      text:{ x:50, y:750, maxWidth:1800 },
    };
    const ctx = harness({
      replaced:true, semanticAuthoring:authoring, preparedPresentation:presentation,
      summaries:[{ id:IMPORTED.id, dialogueStyles:[{ id:IMPORTED.id, name:'Pure', renderer:'image-dialogue-v1' }] }],
    });
    try {
      const result = await ctx.mutations.webGalStyleImport.install({ templateRoot:'/tmp/template', replacePackageId:IMPORTED.id });
      expect(ctx.installWebgalScss).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok:false, message:expect.stringContaining('模板包已更新，但当前场景对白更新失败') });
      expect(result.message).toContain('Projection failed');
    } finally {
      ctx.restore();
    }
  });

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
