import type { CurrentSceneDocument, SceneStatement } from '../../api/types/semantic-scene';
import type { FirstLessonBusinessStep } from './FirstLessonProgress';
import { FIRST_LESSON_BUSINESS_STEPS } from './FirstLessonProgress';

export interface FirstLessonDialogueBaseline {
  time: number;
  duration: number;
}

export interface FirstLessonRuntimeObservation {
  visibleModelCharacterIds?: readonly string[];
  hasPlayedCharacterEntrance?: boolean;
  hasStartedPreview?: boolean;
  hasPreviewedLive2DMotion?: boolean;
  /**
   * First-observed time/duration of each dialogue statement, captured when it first appears.
   * Timeline stretching/dragging is detected as a change relative to these baselines.
   */
  dialogueBaselines?: Readonly<Record<string, FirstLessonDialogueBaseline>>;
  /**
   * First-observed targetPart of each camera focus statement. Changing the
   * focus part is detected as a change relative to these baselines.
   */
  cameraFocusPartBaselines?: Readonly<Record<string, string>>;
}

export interface FirstLessonCompletionContext {
  assetSourceReady: boolean;
  document: CurrentSceneDocument | null;
  runtime?: FirstLessonRuntimeObservation;
  /**
   * Optional explicit model availability map. When omitted, a non-empty model reference is treated as selected.
   * Callers that just ran WebGAL/Live2D dependency checks should pass explicit availability here.
   */
  modelAvailabilityByReference?: Readonly<Record<string, boolean>>;
  defaultDialogueText?: string;
}

export interface FirstLessonCompletionEvaluation {
  completed: boolean;
  firstUnmetStep: FirstLessonBusinessStep | null;
  satisfiedSteps: readonly FirstLessonBusinessStep[];
  selectedCharacterId: string | null;
  selectedModelReference: string | null;
}

const DEFAULT_DIALOGUE_TEXT = '新对白';

export function evaluateFirstLessonCompletion(
  context: FirstLessonCompletionContext,
): FirstLessonCompletionEvaluation {
  const satisfiedSteps: FirstLessonBusinessStep[] = [];
  const document = context.document;
  const selected = findFirstCharacterWithAvailableModel(document, context.modelAvailabilityByReference);
  const selectedCharacterId = selected?.characterId ?? null;
  const selectedModelReference = selected?.modelReference ?? null;

  if (context.assetSourceReady) {
    satisfiedSteps.push('prepare-asset-source');
  }

  if ((document?.meta.characters?.length ?? 0) > 0) {
    satisfiedSteps.push('create-character');
  }

  if (selected) {
    satisfiedSteps.push('select-character-model');
  }

  if (
    selected &&
    hasCharacterEntranceStatement(document, selected.characterId) &&
    (context.runtime?.visibleModelCharacterIds ?? []).includes(selected.characterId) &&
    context.runtime?.hasPlayedCharacterEntrance === true
  ) {
    satisfiedSteps.push('insert-character-entrance');
  }

  if (hasSetEnvironmentBackgroundStatement(document)) {
    satisfiedSteps.push('insert-environment-background');
  }

  if (hasEditedDialogueStatement(document, context.defaultDialogueText ?? DEFAULT_DIALOGUE_TEXT)) {
    satisfiedSteps.push('add-and-edit-dialogue');
  }

  if (hasResizedDialogueDuration(document, context.runtime?.dialogueBaselines)) {
    satisfiedSteps.push('resize-dialogue-duration');
  }

  if (hasMovedDialogueTime(document, context.runtime?.dialogueBaselines)) {
    satisfiedSteps.push('move-dialogue-time');
  }

  if (selected && hasLive2DMotionStatement(document, selected.characterId)) {
    satisfiedSteps.push('add-live2d-motion');
  }

  if (context.runtime?.hasPreviewedLive2DMotion === true) {
    satisfiedSteps.push('preview-live2d-motion');
  }

  if (hasCameraFocusStatement(document)) {
    satisfiedSteps.push('insert-camera-focus');
  }

  if (hasTunedCameraFocusPart(document, context.runtime?.cameraFocusPartBaselines)) {
    satisfiedSteps.push('tune-camera-focus-part');
  }

  if (context.runtime?.hasStartedPreview === true) {
    satisfiedSteps.push('start-preview');
  }

  const satisfied = new Set(satisfiedSteps);
  const firstUnmetStep = FIRST_LESSON_BUSINESS_STEPS.find((step) => !satisfied.has(step)) ?? null;
  return {
    completed: firstUnmetStep === null,
    firstUnmetStep,
    satisfiedSteps,
    selectedCharacterId,
    selectedModelReference,
  };
}

export function firstUnmetFirstLessonStep(
  context: FirstLessonCompletionContext,
): FirstLessonBusinessStep | null {
  return evaluateFirstLessonCompletion(context).firstUnmetStep;
}

function findFirstCharacterWithAvailableModel(
  document: CurrentSceneDocument | null,
  modelAvailabilityByReference: Readonly<Record<string, boolean>> | undefined,
): { characterId: string; modelReference: string } | null {
  for (const character of document?.meta.characters ?? []) {
    for (const modelReference of collectCharacterModelReferences(character)) {
      if (isModelAvailable(modelReference, modelAvailabilityByReference)) {
        return { characterId: character.id, modelReference };
      }
    }
  }
  return null;
}

function collectCharacterModelReferences(
  character: NonNullable<CurrentSceneDocument['meta']['characters']>[number],
): string[] {
  const references = new Set<string>();
  if (character.model?.trim()) references.add(character.model.trim());
  for (const variant of character.variants ?? []) {
    if (variant.model?.trim()) references.add(variant.model.trim());
  }
  return [...references];
}

function isModelAvailable(
  modelReference: string,
  modelAvailabilityByReference: Readonly<Record<string, boolean>> | undefined,
): boolean {
  if (!modelReference.trim()) return false;
  return modelAvailabilityByReference
    ? modelAvailabilityByReference[modelReference] === true
    : true;
}

function hasCharacterEntranceStatement(
  document: CurrentSceneDocument | null,
  characterId: string,
): boolean {
  return (document?.statements ?? []).some((statement) => (
    statement.type === 'characterPresence' &&
    statement.params.mode === 'enter' &&
    statement.params.id === characterId
  ));
}

function hasSetEnvironmentBackgroundStatement(document: CurrentSceneDocument | null): boolean {
  return (document?.statements ?? []).some((statement) => (
    statement.type === 'environmentLayer' &&
    statement.params.mode === 'set' &&
    (
      (typeof statement.params.file === 'string' && statement.params.file.trim() !== '') ||
      (typeof statement.params.image === 'string' && statement.params.image.trim() !== '')
    )
  ));
}

function hasEditedDialogueStatement(
  document: CurrentSceneDocument | null,
  defaultDialogueText: string,
): boolean {
  return (document?.statements ?? []).some((statement) => (
    statement.type === 'dialogue' &&
    isEditedDialogueText(statement, defaultDialogueText)
  ));
}

function hasLive2DMotionStatement(
  document: CurrentSceneDocument | null,
  characterId: string,
): boolean {
  return (document?.statements ?? []).some((statement) => {
    if (statement.type !== 'characterPerformance' || statement.params.target !== characterId) {
      return false;
    }
    const motion = statement.params.motion;
    if (!motion) return false;
    if (motion.kind === 'custom') return true;
    const key = motion.key;
    return !!key.trim() && key.trim().toLowerCase() !== 'idle';
  });
}

function hasCameraFocusStatement(document: CurrentSceneDocument | null): boolean {
  return (document?.statements ?? []).some((statement) => (
    statement.type === 'camera' && statement.params.mode === 'focus'
  ));
}

function hasTunedCameraFocusPart(
  document: CurrentSceneDocument | null,
  baselines: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!baselines) return false;
  return (document?.statements ?? []).some((statement) => {
    if (statement.type !== 'camera' || statement.params.mode !== 'focus') return false;
    const baseline = baselines[statement.id];
    if (!baseline) return false;
    const current = typeof statement.params.targetPart === 'string'
      ? statement.params.targetPart.trim()
      : '';
    return !!current && current !== baseline;
  });
}

function isEditedDialogueText(statement: SceneStatement, defaultDialogueText: string): boolean {
  if (statement.type !== 'dialogue') return false;
  const text = statement.params.text.trim();
  return !!text && text !== defaultDialogueText.trim();
}

const DIALOGUE_CHANGE_EPSILON_SECONDS = 0.05;

function hasResizedDialogueDuration(
  document: CurrentSceneDocument | null,
  baselines: Readonly<Record<string, FirstLessonDialogueBaseline>> | undefined,
): boolean {
  if (!baselines) return false;
  return (document?.statements ?? []).some((statement) => {
    if (statement.type !== 'dialogue') return false;
    const baseline = baselines[statement.id];
    if (!baseline) return false;
    return Math.abs(statement.params.durationSeconds - baseline.duration) > DIALOGUE_CHANGE_EPSILON_SECONDS;
  });
}

function hasMovedDialogueTime(
  document: CurrentSceneDocument | null,
  baselines: Readonly<Record<string, FirstLessonDialogueBaseline>> | undefined,
): boolean {
  if (!baselines) return false;
  return (document?.statements ?? []).some((statement) => {
    if (statement.type !== 'dialogue') return false;
    const baseline = baselines[statement.id];
    if (!baseline) return false;
    return Math.abs(statement.time - baseline.time) > DIALOGUE_CHANGE_EPSILON_SECONDS;
  });
}
