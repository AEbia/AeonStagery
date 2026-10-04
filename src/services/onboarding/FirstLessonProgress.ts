export const FIRST_LESSON_BUSINESS_STEPS = Object.freeze([
  'prepare-asset-source',
  'create-character',
  'select-character-model',
  'insert-character-entrance',
  'insert-environment-background',
  'add-and-edit-dialogue',
  'resize-dialogue-duration',
  'move-dialogue-time',
  'add-live2d-motion',
  'preview-live2d-motion',
  'insert-camera-focus',
  'tune-camera-focus-part',
  'start-preview',
] as const);

export type FirstLessonBusinessStep = typeof FIRST_LESSON_BUSINESS_STEPS[number];

export interface FirstLessonProgressState {
  currentStep: FirstLessonBusinessStep;
  hasStartedPreview: boolean;
  completed: boolean;
  tutorialProjectPath?: string;
}

export interface FirstLessonProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const FIRST_LESSON_PROGRESS_STORAGE_KEY = 'aeonstagery.firstLesson.progress';

export const DEFAULT_FIRST_LESSON_PROGRESS: FirstLessonProgressState = Object.freeze({
  currentStep: 'prepare-asset-source',
  hasStartedPreview: false,
  completed: false,
});

export class FirstLessonProgressStore {
  constructor(
    private readonly storage: FirstLessonProgressStorage,
    private readonly key = FIRST_LESSON_PROGRESS_STORAGE_KEY,
  ) {}

  load(): FirstLessonProgressState {
    const raw = this.storage.getItem(this.key);
    if (!raw) return { ...DEFAULT_FIRST_LESSON_PROGRESS };

    try {
      return normalizeFirstLessonProgressState(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_FIRST_LESSON_PROGRESS };
    }
  }

  save(state: FirstLessonProgressState): FirstLessonProgressState {
    const normalized = normalizeFirstLessonProgressState(state);
    this.storage.setItem(this.key, JSON.stringify(normalized));
    return normalized;
  }

  patch(patch: Partial<FirstLessonProgressState>): FirstLessonProgressState {
    return this.save({
      ...this.load(),
      ...patch,
    });
  }

  setCurrentStep(currentStep: FirstLessonBusinessStep): FirstLessonProgressState {
    return this.patch({ currentStep });
  }

  setTutorialProjectPath(tutorialProjectPath: string): FirstLessonProgressState {
    return this.patch({ tutorialProjectPath });
  }

  markPreviewStarted(): FirstLessonProgressState {
    return this.patch({ hasStartedPreview: true, currentStep: 'start-preview' });
  }

  markCompleted(): FirstLessonProgressState {
    return this.patch({ completed: true, hasStartedPreview: true, currentStep: 'start-preview' });
  }

  reset(): FirstLessonProgressState {
    if (this.storage.removeItem) {
      this.storage.removeItem(this.key);
    }
    return this.save({ ...DEFAULT_FIRST_LESSON_PROGRESS });
  }
}

export function normalizeFirstLessonProgressState(value: unknown): FirstLessonProgressState {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_FIRST_LESSON_PROGRESS };
  }

  const record = value as Record<string, unknown>;
  const persistedStep = record.currentStep === 'add-camera-filter'
    ? 'start-preview'
    : record.currentStep;
  const currentStep = isFirstLessonBusinessStep(persistedStep)
    ? persistedStep
    : DEFAULT_FIRST_LESSON_PROGRESS.currentStep;
  const tutorialProjectPath = typeof record.tutorialProjectPath === 'string' && record.tutorialProjectPath.trim()
    ? record.tutorialProjectPath.trim()
    : undefined;

  return {
    currentStep,
    hasStartedPreview: record.hasStartedPreview === true,
    completed: record.completed === true,
    ...(tutorialProjectPath ? { tutorialProjectPath } : {}),
  };
}

export function isFirstLessonBusinessStep(value: unknown): value is FirstLessonBusinessStep {
  return typeof value === 'string' &&
    (FIRST_LESSON_BUSINESS_STEPS as readonly string[]).includes(value);
}
