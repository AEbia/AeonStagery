/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapContext } from '../engine/Bootstrapper';
import { DEFAULT_PROJECT_ASSET_ROOTS, type ProjectState, type ProjectTemplateConfiguration } from '../api/types/project';
import type { CurrentSceneDocument, DialogueImagePresentation } from '../api/types/semantic-scene';
import type { TemplatePackageDeleteResult } from '../api/types/template-package-import';
import { TemplatePackageCatalog, createLoadedTemplatePackage } from '../services/template-package';
import { useAppProjectWorkspace } from '../ui/hooks/useAppProjectWorkspace';

vi.mock('../ui/SettingsStore', () => ({
  useSettings: () => ({ settings: { externalLibraryMounts: [], hasCompletedExternalLibraryOnboarding: true }, setSetting: vi.fn() }),
  createExternalLibraryMount: vi.fn(), hasExternalLibraryMountPath: vi.fn(), rebindExternalLibraryMount: vi.fn(), renameRecentProject: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

function setup(deleteResult: TemplatePackageDeleteResult = { success: true, id: 'webgal.subtitle' }) {
  const presentation: DialogueImagePresentation = {
    renderer: 'image-dialogue-v1', styleId: 'subtitle',
    textbox: { image: 'images/templates/webgal.subtitle/textbox.png', x: 0, y: 700, width: 1920, minHeight: 250 },
    text: { x: 100, y: 750, maxWidth: 1720 },
  };
  const catalog = new TemplatePackageCatalog([createLoadedTemplatePackage({
    manifestSchemaVersion: 2,
    template: { id: 'webgal.subtitle', aliases: ['webgal.old'], name: 'WebGAL Subtitle', version: '1.0.0', compatibility: { sceneSchemaVersion: 5 } },
    dialogueStyles: [{ id: 'subtitle', name: 'Subtitle', renderer: 'image-dialogue-v1', params: presentation }],
  }, { scope: 'user', packageRoot: '/library/templates/webgal' })]);
  const summary = catalog.getSummaries()[0];
  const refresh = vi.fn(async () => { catalog.setPackages([]); });
  catalog.setRefreshHandler(refresh);
  let project: ProjectState = {
    rootPath: '/project', projectFilePath: '/project/project.json',
    metadata: {
      projectId: 'project', name: 'Project', projectVersion: 2, createdAt: '', updatedAt: '', defaultSceneId: 'main', scenes: [], assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
      templates: { enabledTemplateIds: ['webgal.old'], defaults: { dialogueStyleId: 'subtitle' }, dialoguePresentation: presentation },
    },
  };
  const updateTemplateConfiguration = vi.fn(async (templates: ProjectTemplateConfiguration) => {
    const { dialoguePresentation: _snapshot, ...rest } = templates;
    project = { ...project, metadata: { ...project.metadata, templates: rest } };
    return { success: true, project, scenePath: '/project/main.scene.json' };
  });
  const document: CurrentSceneDocument = {
    schemaVersion: 5, sceneId: 'main', meta: { title: 'Main' },
    statements: [{ id: 'dialogue', type: 'dialogue', time: 0, params: { text: '保留这句对白', durationSeconds: 2, presentation } }],
  };
  const authorTransaction = vi.fn(async () => {});
  const context = {
    services: {
      templatePackages: catalog,
      projectWorkspace: { getCurrentProject: () => project, subscribe: () => () => {}, updateTemplateConfiguration },
      semanticAuthoring: { getDocumentSnapshot: () => document, authorTransaction },
    },
  } as unknown as BootstrapContext;
  const deletePackage = vi.fn(async () => deleteResult);
  Object.defineProperty(window, 'aeonStageryAPI', { configurable: true, value: { templates: { deletePackage } } });
  const hook = renderHook(() => useAppProjectWorkspace(context, true));
  return { ...hook, summary, refresh, updateTemplateConfiguration, authorTransaction, deletePackage };
}

describe('template deletion project workflow', () => {
  it('drops the package alias and subtitle override, and resets the loaded subtitle without deleting dialogue', async () => {
    const workflow = setup();
    await act(async () => { await workflow.result.current.handleDeleteTemplatePackage(workflow.summary); });
    expect(workflow.deletePackage).toHaveBeenCalledWith({ id: 'webgal.subtitle', packageRoot: '/library/templates/webgal' });
    expect(workflow.refresh).toHaveBeenCalledOnce();
    expect(workflow.updateTemplateConfiguration).toHaveBeenCalledWith(expect.objectContaining({ enabledTemplateIds: [], defaults: undefined }));
    expect(workflow.authorTransaction).toHaveBeenCalledWith([
      expect.objectContaining({ statementId: 'dialogue', patch: { params: { text: '保留这句对白', durationSeconds: 2, template: 'glass' } } }),
    ]);
  });

  it('keeps project configuration and the loaded scene when deletion is canceled', async () => {
    const workflow = setup({ success: false, canceled: true });
    await act(async () => { await workflow.result.current.handleDeleteTemplatePackage(workflow.summary); });
    expect(workflow.refresh).not.toHaveBeenCalled();
    expect(workflow.updateTemplateConfiguration).not.toHaveBeenCalled();
    expect(workflow.authorTransaction).not.toHaveBeenCalled();
  });

  it('reports native deletion errors without changing project configuration', async () => {
    const workflow = setup({ success: false, error: '目录被占用' });
    await act(async () => { await expect(workflow.result.current.handleDeleteTemplatePackage(workflow.summary)).rejects.toThrow('目录被占用'); });
    expect(workflow.updateTemplateConfiguration).not.toHaveBeenCalled();
    expect(workflow.authorTransaction).not.toHaveBeenCalled();
  });
});
