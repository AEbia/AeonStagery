import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIRST_LESSON_PROGRESS,
  FirstLessonProgressStore,
  normalizeFirstLessonProgressState,
} from '../services/onboarding/FirstLessonProgress';

function createMemoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('FirstLessonProgress', () => {
  it('normalizes persisted progress to the allowed durable fields', () => {
    expect(normalizeFirstLessonProgressState({
      currentStep: 'select-character-model',
      hasStartedPreview: true,
      completed: false,
      tutorialProjectPath: ' D:/projects/tutorial ',
      transientOverlayTarget: 'ignored',
    })).toEqual({
      currentStep: 'select-character-model',
      hasStartedPreview: true,
      completed: false,
      tutorialProjectPath: 'D:/projects/tutorial',
    });
  });

  it('falls back to the first business step for corrupt or unknown persisted data', () => {
    expect(normalizeFirstLessonProgressState({ currentStep: 'open-panel' })).toEqual(DEFAULT_FIRST_LESSON_PROGRESS);

    const store = new FirstLessonProgressStore(createMemoryStorage({
      'aeonstagery.firstLesson.progress': '{',
    }));
    expect(store.load()).toEqual(DEFAULT_FIRST_LESSON_PROGRESS);
  });

  it('migrates the removed filter tutorial step to preview', () => {
    expect(normalizeFirstLessonProgressState({
      currentStep: 'add-camera-filter',
      hasStartedPreview: false,
      completed: false,
    })).toMatchObject({
      currentStep: 'start-preview',
      hasStartedPreview: false,
      completed: false,
    });
  });

  it('stores preview and completion state without navigation state', () => {
    const storage = createMemoryStorage();
    const store = new FirstLessonProgressStore(storage);

    expect(store.setTutorialProjectPath('D:/projects/tutorial')).toEqual({
      ...DEFAULT_FIRST_LESSON_PROGRESS,
      tutorialProjectPath: 'D:/projects/tutorial',
    });
    expect(store.markPreviewStarted()).toEqual({
      currentStep: 'start-preview',
      hasStartedPreview: true,
      completed: false,
      tutorialProjectPath: 'D:/projects/tutorial',
    });
    expect(store.markCompleted()).toEqual({
      currentStep: 'start-preview',
      hasStartedPreview: true,
      completed: true,
      tutorialProjectPath: 'D:/projects/tutorial',
    });
    expect(store.reset()).toEqual(DEFAULT_FIRST_LESSON_PROGRESS);
  });
});
