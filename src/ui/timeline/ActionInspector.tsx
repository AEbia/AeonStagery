import React, { useState, useEffect } from 'react';
import { useApp, useCharacterAdapter, useCollaborationPresence, useDocumentStore, usePlaybackAdapter } from '../context/AppContext';
import { useSemanticDocument, useValidationIssues, useCustomMotionEditorActionId } from '../store/storeHooks';
import './Inspector.css';
import { CharacterIntegrationControls } from './CharacterIntegrationControls';

import type { CharacterMotionOutput } from '../../api/types/semantic-scene';
import {
  getPrimaryVisualIntentLabel,
  isPrimaryVisualIntent,
} from './visualIntentAuthoring';
import {
  withAuthorFacingEnvironmentLabel,
} from './environmentAuthoring';
import { getActionDisplayLabel } from './TrackComponents';
import { summarizeLocatorEditingPeers } from '../../services/collaboration/CollaborationPresence';
import {
  buildSemanticCopyBufferForTimelineActions,
  locatorForCompiledTimelineAction,
  selectCompiledActionsForStatements,
} from './semanticTimelineEditing';
import {
  getSemanticInspectorFields,
  materializeSemanticInspectorParams,
  type SemanticInspectorField,
} from './semanticInspectorFieldCatalog';
import type { TimelineScene } from './semanticTimelineTypes';
import { CustomMotionConversionDialog } from './CustomMotionConversionDialog';
import { PlayheadLifecycleTargetCommands } from './inspector/PlayheadLifecycleTargetCommands';
import {
  SOURCE_PARAM_FORM_CHARACTER_PERFORMANCE_ACTIONS,
  SOURCE_PARAM_FORM_SEMANTIC_TYPES,
} from './inspector/sourceParamForm';
import {
  getLightingSemanticLabel,
  getVisualStyleSemanticLabel,
} from './inspector/visualStyleLabels';
import { computeParamBase } from './inspector/paramControls/labels';
import {
  computeParamGroups,
  computeVisibleParamKeys,
} from './inspector/paramKeys';
import {
  computePrimaryVisualDescription,
  computePrimaryVisualQuickKeys,
  computeRimLightTargetOptions,
  computeVisualTargetLabel,
} from './inspector/visualIntentMeta';
import { computeLifecyclePeerInfo } from './inspector/lifecyclePeer';
import { createInspectorMutations } from './inspector/inspectorMutations';
import { createCustomMotionConversion } from './inspector/customMotionConversion';
import { InspectorHeader } from './inspector/panels/InspectorHeader';
import {
  CharacterBlinkPanel,
  CharacterLookAtPanel,
  CharacterPerformanceAddControls,
} from './inspector/panels/CharacterPerformancePanels';
import { CustomMotionPanel } from './inspector/panels/CustomMotionPanel';
import { DialogueCompanionPanel } from './inspector/panels/DialogueCompanionPanel';
import { LegacyCameraMotionSection } from './inspector/panels/LegacyCameraMotion';
import { PrimaryVisualPanel } from './inspector/panels/PrimaryVisualPanel';
import { SemanticSourcePanel } from './inspector/panels/SemanticSourcePanel';
import {
  resolveGuardedParam,
  resolveParamControl,
  type InspectorParamContext,
} from './inspector/paramControls';
import { useActionSelection } from './inspector/useActionSelection';
import { useCustomMotionAuthoring } from './inspector/useCustomMotionAuthoring';
import { useInspectorOptions } from './inspector/useInspectorOptions';
import { useModelData } from './inspector/useModelData';

export interface ActionInspectorProps {
  sceneData: TimelineScene;
  selectedActionIds: Record<string, boolean>;
  setSelectedIds: (ids: Record<string, boolean>) => void;
  updateAction: (id: string, updates: any, isTransient?: boolean) => void;
  updateParam: (id: string, key: string, val: any, isTransient?: boolean) => void;
  replaceSourceParams: (id: string, params: Record<string, unknown>) => void | Promise<unknown>;
  deleteAction: (id: string) => void;
  copyActions?: (ids: readonly string[]) => void;
  onClose: () => void | Promise<void>;
  closeMode?: 'back' | 'close';
  inspectorTab?: any;
  setInspectorTab?: any;
}

export const ActionInspector: React.FC<ActionInspectorProps> = (props) => {
  const {
    sceneData,
    selectedActionIds, setSelectedIds,
    updateAction, updateParam, replaceSourceParams,
    deleteAction,
    onClose,
    closeMode = 'back',
  } = props;

  const characterAdapter = useCharacterAdapter();
  const playbackAdapter = usePlaybackAdapter();
  const appContext = useApp();
  const documentStore = useDocumentStore();
  const { document: semanticDocument } = useSemanticDocument();
  const { peers: collaborationPeers } = useCollaborationPresence();
  const editorStore = appContext.stores.editor;
  const semanticAuthoring = appContext.services?.semanticAuthoring;
  const { issues: validationIssues } = useValidationIssues();

  // Selection / model data / options / custom-motion derivations live in inspector hooks.
  const {
    selectedIdsList,
    semanticTimelineItems,
    timelineActions,
    action,
    actionId,
    semanticItem,
    performanceTargetSpeakerId,
  } = useActionSelection({ selectedActionIds, semanticDocument, documentStore });
  const { targetModelPath, modelData, isModelDataLoading } = useModelData({
    characterAdapter,
    sceneData,
    selectedIdsList,
    action,
    performanceTargetSpeakerId,
    timelineActions,
  });
  const {
    environmentLayers,
    visualTargetOptions,
    characterVisualTargetOptions,
    recipeOptions,
    filterTemplateOptions,
    activeFilterTemplateOptions,
  } = useInspectorOptions({ sceneData, action, timelineActions, semanticDocument, semanticItem });
  const sceneFps = semanticDocument?.meta?.fps ?? documentStore.getCurrentSceneDocumentSnapshot()?.meta?.fps ?? 60;
  const {
    customMotionAuthoring,
    customMotionLocator,
    conversionDialog,
    setConversionDialog,
    isConverting,
    setIsConverting,
    estimateKeyframesForDensity,
  } = useCustomMotionAuthoring({ semanticItem, fps: sceneFps });

  const [showVisualAdvanced, setShowVisualAdvanced] = useState(false);
  const [isAutoMatchingVisual, setIsAutoMatchingVisual] = useState(false);

  useEffect(() => {
    setShowVisualAdvanced(false);
    setIsAutoMatchingVisual(false);
  }, [actionId]);

  // 关键帧编辑器改在下方轨道区展开，这里只记录开关（共享状态，轨道区据此渲染展开带）
  const expandedCustomMotionActionId = useCustomMotionEditorActionId();

  if (!action) return null;
  const presenceLocator = actionId ? locatorForCompiledTimelineAction(documentStore, actionId) : null;
  const collaborationEditingSummary = presenceLocator
    ? summarizeLocatorEditingPeers(collaborationPeers, presenceLocator)
    : null;
  const actionType = action.action;
  const usesSourceParamForm = !!action.semanticType &&
    SOURCE_PARAM_FORM_SEMANTIC_TYPES.has(action.semanticType) &&
    (action.semanticType !== 'characterPerformance' ||
      SOURCE_PARAM_FORM_CHARACTER_PERFORMANCE_ACTIONS.has(action.action));
  const sourceParams = usesSourceParamForm && action.sourceParams
    ? action.sourceParams
    : action.params;
  const actionParams = usesSourceParamForm && action.semanticType
    ? materializeSemanticInspectorParams(action.semanticType, sourceParams, sceneData.visual)
    : sourceParams;
  const semanticInspectorFields: readonly SemanticInspectorField[] = usesSourceParamForm && action.semanticType
    ? getSemanticInspectorFields(action.semanticType, sourceParams, sceneData.visual)
    : [];
  const semanticInspectorFieldByKey = new Map(
    semanticInspectorFields.map((fieldDefinition) => [fieldDefinition.key, fieldDefinition] as const),
  );
  const dialogueSpeakerCharacter = actionType === 'dialogue' && typeof actionParams.speakerId === 'string'
    ? sceneData.meta.characters?.find((character) => character.id === actionParams.speakerId)
    : undefined;
  const isCompositeVisualAction = actionType === 'setCompositeRecipe' || actionType === 'modulateComposite';
  // Deprecated compatibility UI: existing historical filter actions remain editable,
  // but no new filter insertion entry is exposed from the statement library.
  const isLensFilterSourceAction = action.semanticType === 'filterAdd'
    || action.semanticType === 'filterChange'
    || action.semanticType === 'filterReset';
  const visualScope = 'object';
  const visualSlot = String(actionParams.slot || (
    action.semanticType === 'visualStyle' || isCompositeVisualAction ? 'integration' : ''
  ));
  const isIntegrationVisualAction = (isCompositeVisualAction || actionType === 'resetCompositeRecipe' || action.semanticType === 'visualStyle') && visualSlot === 'integration';
  const isRimLightVisualAction = actionType === 'setCharacterRimLight'
    || (action.semanticType === 'visualStyle' && visualScope === 'object' && visualSlot === 'rim-light');
  const rimLightTargetOptions = computeRimLightTargetOptions(actionParams, characterVisualTargetOptions);
  const displayAction = withAuthorFacingEnvironmentLabel(sceneData, action);
  const isEnvironmentLayerAuthoringAction = ['setEnvironmentLayer', 'transformEnvironmentLayer', 'removeEnvironmentLayer'].includes(actionType);
  const currentEnvironmentLayer = isEnvironmentLayerAuthoringAction
    ? environmentLayers.find((layer) => layer.layerId === (actionParams.layerId || 'background')) || environmentLayers[0]
    : undefined;
  const actionIssues = validationIssues.filter((issue) => (
    issue.actionId === actionId ||
    issue.actionId === semanticItem?.statementId
  ));
  const actionIssueSeverity = actionIssues.some((issue) => issue.severity === 'error') ? 'error' : actionIssues.length > 0 ? 'warning' : null;
  const primaryVisualIntentLabel = getPrimaryVisualIntentLabel(actionType, actionParams);
  const isPrimaryVisualIntentBlock = action.semanticType !== 'visualStyle' && isPrimaryVisualIntent(actionType, actionParams);
  const actionDisplayName = (() => {
    if (primaryVisualIntentLabel) return primaryVisualIntentLabel;
    if (actionType === 'modulateComposite') return '融合变化';
    return '';
  })();
  const isCharacterEntranceAction = actionType === 'addCharacter' || (
    action.semanticType === 'characterPresence' && actionParams.mode === 'enter'
  );
  const allKeys = computeVisibleParamKeys({
    action, actionType, actionParams, usesSourceParamForm,
    isLensFilterSourceAction, isCompositeVisualAction, isIntegrationVisualAction, isRimLightVisualAction,
    semanticItem, semanticInspectorFields, semanticInspectorFieldByKey, isCharacterEntranceAction,
  });
  const semanticActionLabel = action.semanticType === 'visualStyle'
    ? getVisualStyleSemanticLabel(actionParams)
    : action.semanticType === 'lighting'
      ? getLightingSemanticLabel(actionParams)
      : '';
  const inspectorTitle = actionDisplayName || semanticActionLabel || action.semanticLabel || getActionDisplayLabel(actionType, displayAction.params);
  const actionStart = action.time || 0;
  const actionDuration = actionParams.durationSeconds ?? action.params.duration ?? 0;
  const actionEnd = actionStart + actionDuration;
  const lifecyclePeer = computeLifecyclePeerInfo(documentStore.getCurrentSceneDocumentSnapshot(), semanticItem?.statementId);
  const jumpToLifecyclePeer = () => {
    if (!lifecyclePeer) return;
    const selected = selectCompiledActionsForStatements(
      documentStore.getCompiledSceneSnapshot(),
      [lifecyclePeer.peerId],
    );
    if (Object.keys(selected).length > 0) {
      setSelectedIds(selected);
    }
  };

  const primaryVisualQuickKeys = computePrimaryVisualQuickKeys(isPrimaryVisualIntentBlock, actionType, actionParams);
  const visualTargetLabel = computeVisualTargetLabel(actionType, actionParams, visualTargetOptions);
  const primaryVisualDescription = computePrimaryVisualDescription(actionType, actionParams);

  const {
    updateResourceParam, updateSemanticSourceParam, updateAuthoringParam,
    canRemoveCharacterPerformanceField, updateDialogueSpeaker,
    currentDialogueTemplateValue, customDialogueTemplateOptions, updateDialogueTemplate,
    updateVisualSemanticOverride, commitEnvironmentLayerReference,
  } = createInspectorMutations({
    appContext, action, actionId, actionParams, sourceParams, usesSourceParamForm, sceneData,
    updateAction, updateParam, replaceSourceParams,
  });

  const customMotionValue = typeof actionParams.motion === 'object' && actionParams.motion !== null && actionParams.motion.kind === 'custom'
    ? actionParams.motion as Extract<CharacterMotionOutput, { kind: 'custom' }>
    : null;
  const isResourceMotion = actionType === 'playMotion' && action.semanticType === 'characterPerformance' && !customMotionValue;

  const { openConversionDialog, handleConvertConfirm } = createCustomMotionConversion({
    action, actionId, actionParams, editorStore,
    customMotionAuthoring, customMotionLocator, conversionDialog, setConversionDialog, setIsConverting,
    characterAdapter,
  });

  const hiddenBasicVisualKeys = new Set<string>(
    isPrimaryVisualIntentBlock && !showVisualAdvanced
      ? ['slot', 'recipeId', 'targetId', 'mode', 'colorStops', 'semanticOverride', 'advancedOverride', ...primaryVisualQuickKeys]
      : [],
  );

  const groups = computeParamGroups({ actionType, allKeys, isIntegrationVisualAction, hiddenBasicVisualKeys });

  const paramContext: InspectorParamContext = {
    action, actionId, actionType, actionParams, sourceParams, sceneData, allKeys,
    semanticInspectorFieldByKey, semanticItem, semanticDocument,
    showVisualAdvanced, isPrimaryVisualIntentBlock, isCharacterEntranceAction,
    isCompositeVisualAction, isIntegrationVisualAction, isRimLightVisualAction,
    isLensFilterSourceAction, isEnvironmentLayerAuthoringAction,
    visualSlot, currentEnvironmentLayer, displayAction, performanceTargetSpeakerId,
    customMotionValue, environmentLayers, visualTargetOptions, recipeOptions,
    modelData, isModelDataLoading, targetModelPath, currentDialogueTemplateValue, customDialogueTemplateOptions,
    updateParam, replaceSourceParams, updateResourceParam, updateSemanticSourceParam,
    updateAuthoringParam, updateDialogueSpeaker, updateDialogueTemplate,
    updateVisualSemanticOverride, commitEnvironmentLayerReference, characterAdapter, semanticAuthoring,
  };

  const renderParam = (key: string) => {
    const guarded = resolveGuardedParam(paramContext, key);
    if (guarded !== undefined) return guarded;
    return resolveParamControl(paramContext, key, computeParamBase(paramContext, key));
  };

  const handleSeekToAction = () => {
    void playbackAdapter.seek(actionStart, true);
  };

  const handleCopyAction = () => {
    if (props.copyActions) {
      props.copyActions([actionId]);
      return;
    }
    const statements = buildSemanticCopyBufferForTimelineActions(documentStore, [actionId]);
    if (statements.length > 0) editorStore.setCopyBuffer(statements);
  };

  return (
    <div className="selected-action-inspector">
      <InspectorHeader
        closeMode={closeMode} onClose={onClose} actionId={actionId}
        actionDisplayName={actionDisplayName} inspectorTitle={inspectorTitle}
        actionStart={actionStart} actionEnd={actionEnd}
        lifecyclePeer={lifecyclePeer} jumpToLifecyclePeer={jumpToLifecyclePeer}
        actionIssues={actionIssues} actionIssueSeverity={actionIssueSeverity}
        handleSeekToAction={handleSeekToAction} handleCopyAction={handleCopyAction}
        deleteAction={deleteAction} updateAction={updateAction}
        collaborationEditingSummary={collaborationEditingSummary}
      />

      <div className="selected-action-inspector__body">
        <div className="selected-action-inspector__content">

        <LegacyCameraMotionSection
          action={action} actionType={actionType} actionId={actionId}
          actionParams={actionParams} sceneData={sceneData} updateParam={updateParam}
        />

        <PlayheadLifecycleTargetCommands
          semanticDocument={semanticDocument}
          semanticItem={semanticItem}
          sceneMeta={sceneData.meta}
          semanticAuthoring={semanticAuthoring}
          documentStore={documentStore}
          setSelectedIds={setSelectedIds}
        />

        {isIntegrationVisualAction && <CharacterIntegrationControls key={actionId}
          params={sourceParams} sceneVisual={sceneData.visual} targets={characterVisualTargetOptions}
          targetKey={usesSourceParamForm ? 'target' : 'targetId'}
          durationKey={usesSourceParamForm ? 'durationSeconds' : 'duration'}
          mode={actionType === 'resetCompositeRecipe' ? 'reset' : actionType === 'modulateComposite' ? 'modulate' : 'set'}
          onChange={(next) => usesSourceParamForm ? replaceSourceParams(actionId, next) : updateAction(actionId, { params: next })} />}
        <SemanticSourcePanel
          action={action} actionType={actionType} actionId={actionId} actionParams={actionParams}
          sourceParams={sourceParams} sceneData={sceneData}
          isIntegrationVisualAction={isIntegrationVisualAction} isLensFilterSourceAction={isLensFilterSourceAction}
          isRimLightVisualAction={isRimLightVisualAction} visualTargetOptions={visualTargetOptions}
          rimLightTargetOptions={rimLightTargetOptions} characterVisualTargetOptions={characterVisualTargetOptions}
          filterTemplateOptions={filterTemplateOptions} activeFilterTemplateOptions={activeFilterTemplateOptions}
          semanticInspectorFields={semanticInspectorFields} isResourceMotion={isResourceMotion}
          customMotionAuthoring={customMotionAuthoring} characterAdapter={characterAdapter}
          openConversionDialog={openConversionDialog} updateParam={updateParam}
          replaceSourceParams={replaceSourceParams} updateSemanticSourceParam={updateSemanticSourceParam}
          renderParam={renderParam}
        />
        <CustomMotionPanel
          customMotionValue={customMotionValue} actionId={actionId}
          expandedCustomMotionActionId={expandedCustomMotionActionId}
          editorStore={editorStore} openConversionDialog={openConversionDialog}
        />
        <PrimaryVisualPanel
          isPrimaryVisualIntentBlock={isPrimaryVisualIntentBlock} isIntegrationVisualAction={isIntegrationVisualAction}
          actionType={actionType} action={action} sceneData={sceneData} actionParams={actionParams} actionId={actionId}
          updateAction={updateAction} actionDisplayName={actionDisplayName} primaryVisualDescription={primaryVisualDescription}
          visualTargetLabel={visualTargetLabel} primaryVisualQuickKeys={primaryVisualQuickKeys}
          showVisualAdvanced={showVisualAdvanced} setShowVisualAdvanced={setShowVisualAdvanced}
          isAutoMatchingVisual={isAutoMatchingVisual} setIsAutoMatchingVisual={setIsAutoMatchingVisual}
          renderParam={renderParam}
        />

        {groups.General.length > 0 && (
          <div className="inspector-section">
            <div className="inspector-section-title" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8, marginBottom: 12 }}>
              {isPrimaryVisualIntentBlock && showVisualAdvanced ? '高级属性' : '基础属性'}
            </div>
            <div className="inspector-grid">
              {groups.General.map(key => <React.Fragment key={key}>{renderParam(key)}</React.Fragment>)}
            </div>
          </div>
        )}

        <CharacterLookAtPanel
          action={action} actionType={actionType} actionParams={actionParams} actionId={actionId}
          sceneData={sceneData} updateAuthoringParam={updateAuthoringParam}
          canRemoveCharacterPerformanceField={canRemoveCharacterPerformanceField}
        />
        <CharacterBlinkPanel
          action={action} actionType={actionType} actionParams={actionParams} actionId={actionId}
          sceneData={sceneData} updateAuthoringParam={updateAuthoringParam}
          canRemoveCharacterPerformanceField={canRemoveCharacterPerformanceField}
        />
        <CharacterPerformanceAddControls
          action={action} actionType={actionType} actionParams={actionParams} actionId={actionId}
          sceneData={sceneData} updateAuthoringParam={updateAuthoringParam}
        />

        {groups.Transform.length > 0 && (
          <div className="inspector-section">
            <div className="inspector-section-title" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8, marginBottom: 12 }}>变换属性</div>
            <div className="inspector-grid">
              {groups.Transform.map(key => <React.Fragment key={key}>{renderParam(key)}</React.Fragment>)}
            </div>
          </div>
        )}

        {groups.State.length > 0 && (
          <div className="inspector-section">
            <div className="inspector-section-title" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8, marginBottom: 12 }}>状态与控制</div>
            <div className="inspector-grid">
              {groups.State.map(key => <React.Fragment key={key}>{renderParam(key)}</React.Fragment>)}
            </div>
          </div>
        )}

        <DialogueCompanionPanel
          semanticItem={semanticItem}
          sceneData={sceneData}
          semanticTimelineItems={semanticTimelineItems}
          dialogueSpeakerCharacter={dialogueSpeakerCharacter}
          semanticAuthoring={semanticAuthoring}
          setSelectedIds={setSelectedIds}
          visualTargetOptions={visualTargetOptions}
          characterVisualTargetOptions={characterVisualTargetOptions}
        />

          <CustomMotionConversionDialog
            open={conversionDialog}
            estimateKeyframes={estimateKeyframesForDensity}
            busy={isConverting}
            onConfirm={(density) => { void handleConvertConfirm(density); }}
            onCancel={() => { if (!isConverting) setConversionDialog(null); }}
          />
        </div>
      </div>
    </div>
  );
};
