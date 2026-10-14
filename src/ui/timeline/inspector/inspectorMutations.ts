// All param-mutating callbacks + dialogue-template presentation derivations
// the inspector passes down through InspectorParamContext and the panels.
// Move-only extraction from ActionInspector's component body.
import type { useApp } from '../../context/AppContext';
import { DEFAULT_PROJECT_TEMPLATE_CONFIGURATION } from '../../../api/types/project';
import { buildAvailableDialogueStyles } from '../../templates/TemplateCapabilityConfig';
import { showToast } from '../../Toast';
import type { ActionInspectorProps } from '../ActionInspector';
import type { TimelineAction, TimelineScene } from '../semanticTimelineTypes';
import { asRecord } from './asRecord';
import type { WebGalStyleImportActions } from './paramControls/context';

export interface InspectorMutationsDeps {
  appContext: ReturnType<typeof useApp>;
  action: TimelineAction;
  actionId: string;
  actionParams: Record<string, any>;
  sourceParams: Record<string, any>;
  usesSourceParamForm: boolean;
  sceneData: TimelineScene;
  updateParam: ActionInspectorProps['updateParam'];
  replaceSourceParams: ActionInspectorProps['replaceSourceParams'];
}

export function createInspectorMutations(deps: InspectorMutationsDeps) {
  const {
    appContext, action, actionId, actionParams, sourceParams, usesSourceParamForm, sceneData,
    updateParam, replaceSourceParams,
  } = deps;

  const projectWorkspace = appContext.services?.projectWorkspace;
  const currentProjectTemplates = projectWorkspace?.getCurrentProject()?.metadata.templates;
  const templatePackageSummaries = appContext.services?.templatePackages?.getSummaries() ?? [];
  const availableTemplateDialogueStyles = buildAvailableDialogueStyles(
    templatePackageSummaries,
    currentProjectTemplates?.enabledTemplateIds ?? [],
  ).filter((style) => style.renderer === 'image-dialogue-v1');
  const projectDialoguePresentation = currentProjectTemplates?.dialoguePresentation;
  const projectDialogueStyleId = projectDialoguePresentation
    ? projectDialoguePresentation.styleId || currentProjectTemplates?.defaults?.dialogueStyleId
    : undefined;

  const updateResourceParam = (key: string, value: string) => {
    // A missing optional source field cannot be updated through the compiled
    // action patch mapper: there is no existing key for it to map. Add it via
    // the semantic source replacement seam so a missing model/file picker is
    // an actionable authoring state rather than a runtime-only edit.
    if (
      usesSourceParamForm
      && !Object.prototype.hasOwnProperty.call(sourceParams, key)
    ) {
      replaceSourceParams(actionId, { ...sourceParams, [key]: value });
      return;
    }
    updateParam(actionId, key, value);
  };

  const updateSemanticSourceParam = (key: string, value: unknown, isTransient?: boolean) => {
    if (isTransient) {
      updateParam(actionId, key, value, true);
      return;
    }
    const nextParams = { ...sourceParams };
    if (value === undefined) {
      delete nextParams[key];
    } else {
      nextParams[key] = value;
    }
    replaceSourceParams(actionId, nextParams);
  };

  const updateAuthoringParam = (key: string, value: unknown, isTransient?: boolean) => {
    if (usesSourceParamForm && action.semanticType) {
      updateSemanticSourceParam(key, value, isTransient);
      return;
    }
    updateParam(actionId, key, value, isTransient);
  };

  const canRemoveCharacterPerformanceField = (field: 'lookAt' | 'blink'): boolean => {
    if (action.semanticType !== 'characterPerformance') return false;
    const remainingFields = field === 'lookAt'
      ? ['motion', 'expression', 'blink']
      : ['motion', 'expression', 'lookAt'];
    return remainingFields.some((key) => sourceParams[key] !== undefined);
  };

  const updateDialogueSpeaker = (value: string) => {
    if (!value) {
      const nextParams = { ...sourceParams };
      delete nextParams.speakerId;
      delete nextParams.speaker;
      delete nextParams.speakerColor;
      replaceSourceParams(actionId, nextParams);
      return;
    }
    const character = sceneData.meta.characters?.find((candidate) => candidate.id === value || candidate.name === value);
    if (!character) {
      updateAuthoringParam('speakerId', value);
      return;
    }

    const nextParams: Record<string, unknown> = {
      ...sourceParams,
      speakerId: character.id,
      speaker: character.name,
    };
    if (character.color) nextParams.speakerColor = character.color;
    else delete nextParams.speakerColor;
    replaceSourceParams(actionId, nextParams);
  };

  const actionImageDialoguePresentation = actionParams.presentation?.renderer === 'image-dialogue-v1'
    ? actionParams.presentation
    : undefined;
  const actionUsesProjectDialoguePresentation = !!actionImageDialoguePresentation
    && !!projectDialoguePresentation
    && JSON.stringify(actionImageDialoguePresentation) === JSON.stringify(projectDialoguePresentation);
  const availableTemplateDialogueStyleIds = new Set(availableTemplateDialogueStyles.map((style) => style.id));
  const actionDialogueStyleId = typeof actionImageDialoguePresentation?.styleId === 'string'
    ? actionImageDialoguePresentation.styleId
    : undefined;
  const selectedTemplateDialogueStyleId = actionDialogueStyleId
    || (actionUsesProjectDialoguePresentation ? projectDialogueStyleId : undefined);
  const currentDialogueTemplateValue = actionImageDialoguePresentation
    ? selectedTemplateDialogueStyleId && availableTemplateDialogueStyleIds.has(selectedTemplateDialogueStyleId)
      ? selectedTemplateDialogueStyleId
      : '__current-image-dialogue__'
    : actionParams.template || 'glass';
  const customDialogueTemplateOptions = [
    ...availableTemplateDialogueStyles.map((style) => ({
      value: style.id,
      label: style.name,
    })),
    ...(currentDialogueTemplateValue === '__current-image-dialogue__' ? [{
      value: '__current-image-dialogue__',
      label: '当前图片样式',
      disabled: true,
    }] : []),
  ];
  const updateDialogueTemplate = async (value: string) => {
    const nextParams = { ...sourceParams };
    if (['glass', 'minimal', 'classic'].includes(value)) {
      delete nextParams.presentation;
      nextParams.template = value;
      replaceSourceParams(actionId, nextParams);
      return;
    }
    try {
      if (!projectWorkspace) throw new Error('Project workspace is unavailable');
      const prepared = await projectWorkspace.prepareDialogueStyle(value);
      if (prepared.dialoguePresentation) {
        delete nextParams.template;
        nextParams.presentation = JSON.parse(JSON.stringify(prepared.dialoguePresentation));
      } else if (prepared.dialogueTemplate) {
        delete nextParams.presentation;
        nextParams.template = prepared.dialogueTemplate;
      } else {
        throw new Error(`Dialogue style is unavailable: ${value}`);
      }
      replaceSourceParams(actionId, nextParams);
    } catch (error: any) {
      showToast(`对话框样式应用失败：${error?.message || String(error)}`, 'error');
    }
  };

  // The style list is derived from the template catalog, so an import has to
  // re-scan the library before the new style can be selected.
  const templatePackageCatalog = appContext.services?.templatePackages;

  /**
   * Make an imported package usable from the current project.
   *
   * The dialogue style list is filtered by `enabledTemplateIds`, so a package
   * that is merely installed is invisible: the import reports success while its
   * style stays missing from the dropdown until the user enables it by hand.
   *
   * `metadata.templates` is optional — the project type and its codec both allow
   * it to be absent, and other surfaces supply this default — so a project
   * without one is filled in rather than skipped. A replace of an already
   * enabled package still goes through the save, because that is what
   * re-materialises the project's default `dialoguePresentation` snapshot: the
   * style was just rewritten on disk, and leaving the snapshot alone would keep
   * new dialogues on the old artwork.
   */
  const enableImportedPackage = async (packageId: string): Promise<void> => {
    const project = projectWorkspace?.getCurrentProject();
    if (!projectWorkspace || !project) return;
    const currentTemplates = project.metadata.templates ?? DEFAULT_PROJECT_TEMPLATE_CONFIGURATION;
    const enabled = (currentTemplates.enabledTemplateIds ?? []).includes(packageId);
    const availableOrder = (appContext.services?.templatePackages?.getSummaries() ?? [])
      .map((entry) => entry.id);
    const enabledTemplateIds = enabled
      ? [...(currentTemplates.enabledTemplateIds ?? [])]
      : [...(currentTemplates.enabledTemplateIds ?? []), packageId]
        .sort((left, right) => availableOrder.indexOf(left) - availableOrder.indexOf(right));
    const result = await projectWorkspace.updateTemplateConfiguration({
      ...currentTemplates,
      enabledTemplateIds,
    });
    // `updateTemplateConfiguration` can report failure *after* the project was
    // already saved (it resolves the default scene last), so the session is
    // asked rather than the flag believed: reporting "not enabled" for a
    // package that is enabled would send the user looking for a problem.
    const applied = (projectWorkspace.getCurrentProject()?.metadata.templates?.enabledTemplateIds ?? [])
      .includes(packageId);
    if (!applied && !result.success) {
      showToast(`已导入，但未能在当前项目启用：${result.error ?? '未知错误'}`, 'error');
    }
  };

  const webGalStyleImport: WebGalStyleImportActions = {
    inspect: async () => {
      const templates = window.aeonStageryAPI?.templates;
      if (!templates?.inspectWebgalScss) {
        showToast('当前桌面版本不支持导入 WebGAL 模板，请更新应用', 'error');
        return null;
      }
      try {
        const result = await templates.inspectWebgalScss();
        if (!result.success) {
          if (!result.canceled) showToast(`读取模板失败：${result.error ?? '未知错误'}`, 'error');
          return null;
        }
        return result.inspection;
      } catch (error) {
        showToast(`读取模板失败：${error instanceof Error ? error.message : String(error)}`, 'error');
        return null;
      }
    },
    install: async (request) => {
      const templates = window.aeonStageryAPI?.templates;
      if (!templates?.installWebgalScss) {
        return { ok: false, message: '当前桌面版本不支持导入 WebGAL 模板，请更新应用' };
      }
      try {
        const result = await templates.installWebgalScss(request);
        if (!result.success) {
          return { ok: false, message: `导入失败：${result.error ?? '未知错误'}` };
        }
        if (templatePackageCatalog) await templatePackageCatalog.refresh();
        // Refreshing alone is not enough: the style is only buildable once the
        // package is enabled for the project, so enable it while persisting the
        // project template configuration.
        await enableImportedPackage(result.package.id);
        return {
          ok: true,
          message: `${result.package.replaced ? '已更新' : '已导入'}字幕样式：${result.package.name}`,
        };
      } catch (error) {
        return {
          ok: false,
          message: `导入失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };

  const updateVisualSemanticOverride = (key: string, value: unknown, isTransient?: boolean) => {
    const currentOverride = asRecord(sourceParams.semanticOverride);
    const nextOverride = { ...currentOverride };
    if (value === undefined || value === '') delete nextOverride[key];
    else nextOverride[key] = value;
    updateSemanticSourceParam(
      'semanticOverride',
      Object.keys(nextOverride).length > 0 ? nextOverride : undefined,
      isTransient,
    );
  };

  return {
    updateResourceParam,
    updateSemanticSourceParam,
    updateAuthoringParam,
    canRemoveCharacterPerformanceField,
    updateDialogueSpeaker,
    currentDialogueTemplateValue,
    customDialogueTemplateOptions,
    updateDialogueTemplate,
    webGalStyleImport,
    updateVisualSemanticOverride,
  };
}
