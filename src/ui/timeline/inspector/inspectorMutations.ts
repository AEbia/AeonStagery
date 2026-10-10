// All param-mutating callbacks + dialogue-template presentation derivations
// the inspector passes down through InspectorParamContext and the panels.
// Move-only extraction from ActionInspector's component body.
import type { useApp } from '../../context/AppContext';
import { buildAvailableDialogueStyles } from '../../templates/TemplateCapabilityConfig';
import { showToast } from '../../Toast';
import type { ActionInspectorProps } from '../ActionInspector';
import type { TimelineAction, TimelineScene } from '../semanticTimelineTypes';
import { asRecord } from './asRecord';

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
    updateVisualSemanticOverride,
  };
}
