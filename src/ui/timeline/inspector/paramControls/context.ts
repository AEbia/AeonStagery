// Shared context + resolver contract for the inspector param-control dispatch chain.
// The chain that used to live inline in ActionInspector.renderParam is split into
// ordered resolvers; each returns:
//   undefined -> not handled (fall through to the next resolver)
//   null      -> handled, render nothing (hide the key)
//   ReactNode -> handled control
import type * as React from 'react';
import type { ActionInspectorProps } from '../../ActionInspector';
import type { SemanticInspectorField } from '../../semanticInspectorFieldCatalog';
import type { SemanticTimelineReadModelItem } from '../../semanticTimelineReadModel';
import type { useSemanticDocument } from '../../../store/storeHooks';
import type { TimelineAction, TimelineScene } from '../../semanticTimelineTypes';
import type { CharacterMotionOutput } from '../../../../api/types/semantic-scene';
import type { useCharacterAdapter } from '../../../context/AppContext';
import type { SemanticAuthoringApplicationService } from '../../../../services/timeline-authoring/SemanticAuthoringApplicationService';
import type {
  WebGalScssImportInspection,
  WebGalScssImportInstallRequest,
} from '../../../../api/types/template-package-import';

export type InspectorSemanticDocument = ReturnType<typeof useSemanticDocument>['document'];

/** Per-key facts computed once by renderParam before the control resolvers run. */
export interface ParamControlBase {
  val: any;
  label: string;
  fieldId: string;
  paramTestId: string;
  catalogField: SemanticInspectorField | undefined;
}

/** The component environment the dispatch chain closes over, passed explicitly. */
/**
 * Importing a WebGAL dialogue template, injected by the host rather than read
 * from a global so panels stay testable and a host without the feature can
 * simply omit it.
 */
export interface WebGalStyleImportActions {
  /**
   * Ask the host to pick a template directory and read it. Returns `null` when
   * the user cancelled or the directory could not be read (the host reports why).
   */
  inspect: () => Promise<WebGalScssImportInspection | null>;
  /**
   * Write an inspected template into the template library. `message` is written
   * for the user either way, so the host owns the wording.
   */
  install: (
    request: WebGalScssImportInstallRequest,
  ) => Promise<{ ok: boolean; message: string }>;
}

export interface InspectorParamContext {
  rowFieldKeys?: ReadonlySet<string>;
  action: TimelineAction;
  actionId: string;
  actionType: string;
  actionParams: Record<string, any>;
  sourceParams: Record<string, any>;
  sceneData: TimelineScene;
  allKeys: string[];
  semanticInspectorFieldByKey: Map<string, SemanticInspectorField>;
  semanticItem: SemanticTimelineReadModelItem | undefined;
  semanticDocument: InspectorSemanticDocument;
  showVisualAdvanced: boolean;
  isPrimaryVisualIntentBlock: boolean;
  isCharacterEntranceAction: boolean;
  isCompositeVisualAction: boolean;
  isIntegrationVisualAction: boolean;
  isRimLightVisualAction: boolean;
  isLensFilterSourceAction: boolean;
  isEnvironmentLayerAuthoringAction: boolean;
  visualSlot: string;
  displayAction: any;
  performanceTargetSpeakerId: string | undefined;
  customMotionValue: Extract<CharacterMotionOutput, { kind: 'custom' }> | null;
  environmentLayers: ReturnType<typeof import('../../environmentAuthoring').listAuthorFacingEnvironmentLayers>;
  visualTargetOptions: Array<{ value: string; label: string }>;
  recipeOptions: Array<{ value: string; label: string }>;
  modelData: { motions: string[], expressions: string[] };
  isModelDataLoading: boolean;
  targetModelPath?: string;
  currentDialogueTemplateValue: string;
  customDialogueTemplateOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  updateParam: ActionInspectorProps['updateParam'];
  replaceSourceParams: ActionInspectorProps['replaceSourceParams'];
  updateResourceParam: (key: string, value: string) => void;
  updateSemanticSourceParam: (key: string, value: unknown, isTransient?: boolean) => void;
  updateAuthoringParam: (key: string, value: unknown, isTransient?: boolean) => void;
  updateDialogueSpeaker: (value: string) => void;
  updateDialogueTemplate: (value: string) => Promise<void>;
  updateVisualSemanticOverride: (key: string, value: unknown, isTransient?: boolean) => void;
  characterAdapter: ReturnType<typeof useCharacterAdapter>;
  semanticAuthoring: SemanticAuthoringApplicationService | undefined;
  /** Present when the host can import WebGAL dialogue templates. */
  webGalStyleImport?: WebGalStyleImportActions;
}

export type ParamControlResolver = (
  ctx: InspectorParamContext,
  key: string,
  base: ParamControlBase,
) => React.ReactNode | undefined;
