import { useCallback, useEffect, useState } from 'react';
import type { BootstrapContext } from '../../engine/Bootstrapper';
import type { ProjectWorkflowResult } from '../../api/interfaces/IProjectOpenWorkflow';
import type { ProjectState, ProjectTemplateConfiguration } from '../../api/types/project';
import type { WebGalImportInput } from '../../services/import/webgal';
import type { TemplatePackageSummary } from '../../services/template-package';
import { AUTHORING_SCHEMA_VERSION } from '../../api/types/authoring';
import { eventBus } from '../../api/events';
import {
  createExternalLibraryMount,
  hasExternalLibraryMountPath,
  rebindExternalLibraryMount,
  useSettings,
} from '../SettingsStore';
import { showToast } from '../Toast';

/** Coordinates project workflows, template edits, and external library settings. */
export function useAppProjectWorkspace(contextValue: BootstrapContext, hasLoadedScene: boolean) {
  const { settings, setSetting } = useSettings();
  const [isCollaborationJoinHomeLocked, setIsCollaborationJoinHomeLocked] = useState(false);
  const [currentProject, setCurrentProject] = useState<ProjectState | null>(() => contextValue.services.projectWorkspace.getCurrentProject());
  const [templatePackages, setTemplatePackages] = useState<TemplatePackageSummary[]>(
    () => contextValue.services.templatePackages.getSummaries(),
  );
  const [templatePackageRevision, setTemplatePackageRevision] = useState(
    () => contextValue.services.templatePackages.getRevision(),
  );
  useEffect(() => {
    const unsubscribeProject = contextValue.services.projectWorkspace.subscribe(() => {
      const project = contextValue.services.projectWorkspace.getCurrentProject();
      setCurrentProject(project);
    });
    const unsubscribeTemplates = contextValue.services.templatePackages.subscribe(() => {
      setTemplatePackages(contextValue.services.templatePackages.getSummaries());
      setTemplatePackageRevision(contextValue.services.templatePackages.getRevision());
    });
    return () => {
      unsubscribeProject();
      unsubscribeTemplates();
    };
  }, [contextValue.services.projectWorkspace, contextValue.services.templatePackages]);

  const handleLoadFile = useCallback(async (): Promise<boolean> => {
    const res = await contextValue.services.sceneFile.loadFile();
    if (res.success) {
      showToast('剧本加载成功！', 'success');
      if (res.issues && res.issues.length > 0) {
        const errors = res.issues.filter((i) => i.severity === 'error');
        const warnings = res.issues.filter((i) => i.severity === 'warning');
        const parts: string[] = [];
        if (errors.length) parts.push(`${errors.length} 个错误`);
        if (warnings.length) parts.push(`${warnings.length} 个警告`);
        showToast(`场景校验: ${parts.join('，')} · 查看控制台了解详情`, 'warning');
      }
      return true;
    }
    if ('error' in res) {
      showToast(`加载剧本失败: ${res.error}`, 'error');
    }
    return false;
  }, [contextValue.services.sceneFile]);

  const showProjectWorkflowResult = useCallback((result: ProjectWorkflowResult, mode: 'create' | 'open' | 'recent', notifySuccess = true) => {
    if (!result.success) {
      if (result.outcome === 'project_create_failed') {
        showToast(`创建项目失败: ${result.error}`, 'error');
        return;
      }
      if (result.outcome === 'project_open_failed') {
        showToast(`${mode === 'recent' ? '打开最近项目失败' : '打开项目失败'}: ${result.error}`, 'error');
        return;
      }
      if (result.outcome === 'default_scene_load_failed') {
        showToast(`打开项目失败（默认场景校验未通过）: ${result.error}`, 'error');
        return;
      }
      return;
    }

    const verb = mode === 'create' ? '已创建项目并加载默认场景' : '已打开项目并加载默认场景';
    if (notifySuccess) showToast(`${verb}: ${result.project?.metadata.name}`, 'success');
    if (result.issues && result.issues.length > 0) {
      const errors = result.issues.filter((i) => i.severity === 'error');
      const warnings = result.issues.filter((i) => i.severity === 'warning');
      const parts: string[] = [];
      if (errors.length) parts.push(`${errors.length} 个错误`);
      if (warnings.length) parts.push(`${warnings.length} 个警告`);
      showToast(`场景校验: ${parts.join('，')} · 查看控制台了解详情`, 'warning');
    }
  }, []);

  const handleCreateProject = useCallback(async ({
    name,
    rootPath,
    templates,
    webgal,
  }: {
    name: string;
    rootPath: string;
    templates?: ProjectTemplateConfiguration;
    webgal?: WebGalImportInput;
  }) => {
    setIsCollaborationJoinHomeLocked(false);
    const result = await contextValue.services.projectOpenWorkflow.createProjectAndLoadDefaultScene({
      name,
      rootPath,
      templates,
      webgal,
    });
    if (result.success && result.webgalReport) {
      const { stats, characters, unsupportedCommands } = result.webgalReport;
      const parts = [
        `对白 ${stats.dialogueCount + stats.narrationCount} 句`,
        `角色 ${characters.length} 个`,
        `背景 ${stats.backgroundChanges} 处`,
      ];
      if (unsupportedCommands.length > 0) parts.push(`未识别指令 ${unsupportedCommands.length} 条`);
      const scriptCount = 1 + (webgal?.additionalScripts?.length ?? 0);
      showToast(
        `已导入 WebGAL 剧本${scriptCount > 1 ? `（${scriptCount} 个剧本合并连续演出）` : ''}：${parts.join('、')}`,
        'success',
      );
    }
    showProjectWorkflowResult(result, 'create');
  }, [contextValue.services.projectOpenWorkflow, showProjectWorkflowResult]);

  const handleRegenerateWebGalScene = useCallback(async (speed: number) => {
    const result = await contextValue.services.projectOpenWorkflow.regenerateWebGalSceneAndReload({ speed });
    if (result.success) {
      showToast('已重新生成 WebGAL 场景', 'success');
      if (result.webgalReport && result.webgalReport.unsupportedCommands.length > 0) {
        showToast(`重新生成中 ${result.webgalReport.unsupportedCommands.length} 条指令未识别（已跳过）`, 'warning');
      }
    } else {
      showToast(`重新生成失败：${result.error ?? '未知错误'}`, 'error');
    }
  }, [contextValue.services.projectOpenWorkflow]);

  const handleRegisterWebGalAssetSource = useCallback(async () => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择 WebGAL 素材目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;

    const nextPath = result.filePaths[0].replace(/\\/g, '/').replace(/[\\/]+$/, '');
    const existing = settings.externalLibraryMounts || [];
    const existingMount = existing.find((mount) => (
      mount.path.replace(/\\/g, '/').replace(/[\\/]+$/, '').toLowerCase() === nextPath.toLowerCase()
    ));
    if (existingMount) {
      return { mountId: existingMount.id, path: existingMount.path };
    }

    const mount = createExternalLibraryMount(nextPath, existing);
    setSetting('externalLibraryMounts', [...existing, mount]);
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已连接 WebGAL 素材目录', 'success');
    return { mountId: mount.id, path: mount.path };
  }, [settings.externalLibraryMounts, setSetting]);

  const handleSaveTemplateConfiguration = useCallback(async (
    templates: ProjectTemplateConfiguration,
    options: { importCharacters?: boolean } = {},
  ) => {
    const previousDialoguePresentation = contextValue.services.projectWorkspace
      .getCurrentProject()?.metadata.templates?.dialoguePresentation;
    await contextValue.services.templatePackages.refresh();
    const result = await contextValue.services.projectWorkspace.updateTemplateConfiguration(templates);
    if (!result.success) {
      showToast(result.error, 'error');
      return;
    }

    const nextTemplates = result.project.metadata.templates;
    const nextDialoguePresentation = nextTemplates?.dialoguePresentation;
    if (hasLoadedScene && previousDialoguePresentation) {
      const document = contextValue.services.semanticAuthoring.getDocumentSnapshot();
      const previousStyleId = previousDialoguePresentation.styleId;
      const refreshTargets = document.statements.filter((statement) => {
        if (statement.type !== 'dialogue') return false;
        const presentation = statement.params.presentation as typeof previousDialoguePresentation | undefined;
        if (!presentation || presentation.renderer !== 'image-dialogue-v1') return false;
        return previousStyleId
          ? presentation.styleId === previousStyleId
          : JSON.stringify(presentation) === JSON.stringify(previousDialoguePresentation);
      });
      if (refreshTargets.length > 0) {
        await contextValue.services.semanticAuthoring.authorTransaction(refreshTargets.map((statement) => {
          const params = { ...statement.params } as Record<string, unknown>;
          if (nextDialoguePresentation) {
            delete params.template;
            params.presentation = JSON.parse(JSON.stringify(nextDialoguePresentation));
          } else {
            delete params.presentation;
            params.template = nextTemplates?.dialogueTemplate ?? 'glass';
          }
          return {
            version: AUTHORING_SCHEMA_VERSION,
            correlationId: `template_style_refresh_${statement.id}`,
            origin: 'template-config' as const,
            kind: 'update-statement' as const,
            statementId: statement.id,
            patch: { params },
          };
        }));
      }
    }

    if (options.importCharacters) {
      if (!hasLoadedScene) {
        showToast('当前没有加载场景，已仅保存模板配置', 'warning');
        return;
      }
      try {
        const characters = await contextValue.services.projectWorkspace.prepareTemplateCharacters(templates);
        const receipt = await contextValue.services.semanticAuthoring.applyCharacterCommand({
          kind: 'add-template-characters',
          origin: 'template-config',
          characters,
        });
        if (receipt.affectedCharacterIds.length > 0) {
          showToast(`已导入 ${receipt.affectedCharacterIds.length} 个模板角色`, 'success');
        } else {
          showToast('模板配置已保存；选中的角色已在当前场景中', 'info');
        }
      } catch (error: unknown) {
        showToast(`模板角色导入失败: ${error instanceof Error ? error.message : String(error)}`, 'error');
        return;
      }
    } else {
      showToast('模板配置已保存', 'success');
    }
  }, [
    contextValue.services.semanticAuthoring,
    contextValue.services.templatePackages,
    contextValue.services.projectWorkspace,
    hasLoadedScene,
  ]);

  const handleBrowseCreateLocation = useCallback(async (_currentPath: string) => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择项目位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return null;
    }
    return result.filePaths[0].replace(/\\/g, '/');
  }, []);

  const handleBrowseCollaborationDirectory = useCallback(async (_currentPath: string) => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择协作本地目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return null;
    }
    return result.filePaths[0].replace(/\\/g, '/');
  }, []);

  const handleOpenProject = useCallback(async () => {
    setIsCollaborationJoinHomeLocked(false);
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '打开 AeonStagery 项目',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'AeonStagery Project', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return;

    const workflowResult = await contextValue.services.projectOpenWorkflow.openProjectAndLoadDefaultScene(result.filePaths[0]);
    showProjectWorkflowResult(workflowResult, 'open');
  }, [contextValue.services.projectOpenWorkflow, showProjectWorkflowResult]);

  useEffect(() => {
    return eventBus.on('ui:openProject', handleOpenProject);
  }, [handleOpenProject]);

  const handleOpenRecentProject = useCallback(async (projectFilePath: string) => {
    setIsCollaborationJoinHomeLocked(false);
    const workflowResult = await contextValue.services.projectOpenWorkflow.openRecentProjectAndLoadDefaultScene(projectFilePath);
    showProjectWorkflowResult(workflowResult, 'recent');
  }, [contextValue.services.projectOpenWorkflow, showProjectWorkflowResult]);

  const handleImportTemplatePackage = useCallback(async () => {
    const templateImporter = window.aeonStageryAPI.templates;
    if (!templateImporter) {
      showToast('当前桌面版本不支持导入模板包，请更新应用', 'error');
      return;
    }
    const result = await templateImporter.importZip();
    if (!result.success) {
      if (!result.canceled) showToast(`模板包导入失败：${result.error ?? '未知错误'}`, 'error');
      return;
    }
    await contextValue.services.templatePackages.refresh();
    showToast(
      `${result.package.replaced ? '已更新' : '已导入'}模板：${result.package.name} ${result.package.version}`,
      'success',
    );
  }, [contextValue.services.templatePackages]);

  const handleChooseExternalLibrary = useCallback(async () => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '选择外部素材库目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return;
    }

    const nextPath = result.filePaths[0];
    const existing = settings.externalLibraryMounts || [];
    const deduped = hasExternalLibraryMountPath(existing, nextPath)
      ? existing
      : [...existing, createExternalLibraryMount(nextPath, existing)];
    setSetting('externalLibraryMounts', deduped);
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已连接外部素材库', 'success');
  }, [settings.externalLibraryMounts, setSetting]);

  const handleReplaceExternalLibrary = useCallback(async (index: number) => {
    const result = await window.aeonStageryAPI.dialog.showOpen({
      title: '替换外部素材库目录',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return;
    }

    const nextPath = result.filePaths[0];
    const existing = settings.externalLibraryMounts || [];
    const nextMounts = rebindExternalLibraryMount(existing, index, nextPath);
    setSetting('externalLibraryMounts', nextMounts);
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已更新外部素材库', 'success');
  }, [settings.externalLibraryMounts, setSetting]);

  const handleRemoveExternalLibrary = useCallback((index: number) => {
    const existing = settings.externalLibraryMounts || [];
    const nextMounts = existing.filter((_, mountIndex) => mountIndex !== index);
    setSetting('externalLibraryMounts', nextMounts);
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已移除外部素材库', 'info');
  }, [settings.externalLibraryMounts, setSetting]);

  const handleSkipExternalLibrary = useCallback(async () => {
    setSetting('hasCompletedExternalLibraryOnboarding', true);
    showToast('已跳过外部素材库设置，可稍后在设置中补充', 'info');
  }, [setSetting]);

  const shouldPromptExternalLibrary = !settings.hasCompletedExternalLibraryOnboarding
    && (settings.externalLibraryMounts?.length ?? 0) === 0;
  const externalLibraryPaths = (settings.externalLibraryMounts || []).map((mount) => mount.path);

  return {
    currentProject, templatePackages, templatePackageRevision,
    isCollaborationJoinHomeLocked, setIsCollaborationJoinHomeLocked, showProjectWorkflowResult,
    handleLoadFile, handleCreateProject, handleOpenProject, handleOpenRecentProject,
    handleRegenerateWebGalScene, handleRegisterWebGalAssetSource, handleSaveTemplateConfiguration,
    handleBrowseCreateLocation, handleBrowseCollaborationDirectory, handleImportTemplatePackage,
    handleChooseExternalLibrary, handleReplaceExternalLibrary, handleRemoveExternalLibrary,
    handleSkipExternalLibrary, shouldPromptExternalLibrary, externalLibraryPaths,
  };
}
