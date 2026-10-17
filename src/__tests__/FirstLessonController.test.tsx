/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ProjectWorkflowResult } from '../api/interfaces/IProjectOpenWorkflow';
import type { IFileAccess } from '../services/io/IFileAccess';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { FirstLessonController, type FirstLessonControllerProps } from '../ui/onboarding/FirstLessonController';
import { settingsManager } from '../ui/SettingsStore';
import { useModalDialog } from '../ui/hooks/useModalDialog';
import { checkFirstLessonLive2DModelReadiness, checkWebGalAssetSourceReadiness } from '../services/onboarding';
import { FirstLessonProgressStore } from '../services/onboarding/FirstLessonProgress';

vi.mock('../services/onboarding', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/onboarding')>(),
  checkWebGalAssetSourceReadiness: vi.fn(async () => ({
    status: 'found' as const,
    rootPath: '/assets',
    figurePath: '/assets/figure',
    modelEntryPath: '/assets/figure/anon/model.json',
    modelEntryRelativePath: 'anon/model.json',
    runtimeFamily: 'cubism2' as const,
  })),
  checkFirstLessonLive2DModelReadiness: vi.fn(async () => ({ status: 'found' })),
}));
vi.mock('../ui/hooks/useModalDialog', async (importOriginal) => {
  const original = await importOriginal<typeof import('../ui/hooks/useModalDialog')>();
  return { useModalDialog: vi.fn(original.useModalDialog) };
});

const entranceDocument: CurrentSceneDocument = {
  schemaVersion: SCENE_SCHEMA_VERSION,
  sceneId: 'lesson',
  meta: { title: 'Lesson', characters: [{ id: 'anon', name: 'Anon', model: 'figure/model.json' }] },
  statements: [{ id: 'entrance', time: 0, type: 'characterPresence', params: { mode: 'enter', id: 'anon' } }],
};

function renderLesson(document: CurrentSceneDocument | null = null, currentTime = 0) {
  const fileAccess = mock<IFileAccess>();
  fileAccess.join.mockImplementation(async (...parts) => parts.join('/'));
  fileAccess.exists.mockResolvedValue(false);
  const listeners = new Set<() => void>();
  const timeListeners = new Set<(time: number) => void>();
  const playbackAdapter = {
    getCurrentTime: () => currentTime,
    subscribeTime(listener: (time: number) => void) {
      timeListeners.add(listener);
      return () => { timeListeners.delete(listener); };
    },
  };
  const playbackStore = {
    playing: false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  let visible = false;
  const props: FirstLessonControllerProps = {
    semanticDocument: document,
    externalLibraryPaths: ['/assets'],
    defaultProjectDirectory: '/projects',
    fileAccess,
    projectOpenWorkflow: { createProjectAndLoadDefaultScene: vi.fn(async (): Promise<ProjectWorkflowResult> => ({
      success: true, outcome: 'project_ready', failureKind: null, messageKey: 'project_ready',
    })) },
    projectResources: { resolveForRead: vi.fn(async (reference: string) => reference) },
    characterAdapter: { hasCharacter: () => visible },
    playbackStore,
    playbackAdapter,
    children: ({ startFirstLesson }: { startFirstLesson: () => void }) => (
      <><button onClick={startFirstLesson}>Start</button><button className="btn--play">Play</button>
        <div className="timeline-ruler" />
        <div data-tutorial-target="timeline-blank-start" />
        <div data-tutorial-target="external-library-replace-0" /></>
    ),
  };
  const result = render(<FirstLessonController {...props} />);
  return {
    ...result,
    setPlaying(playing: boolean) {
      act(() => { playbackStore.playing = playing; listeners.forEach((listener) => listener()); });
    },
    setTime(time: number) {
      act(() => { currentTime = time; timeListeners.forEach((listener) => listener(time)); });
    },
    showCharacter() { visible = true; },
    hideCharacter() { visible = false; },
    updateDocument(next: CurrentSceneDocument) { result.rerender(<FirstLessonController {...props} semanticDocument={next} />); },
  };
}

async function openLayoutChooser() {
  fireEvent.click(screen.getByText('Start'));
  fireEvent.click(screen.getByRole('button', { name: '不是' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(screen.getByText('选择你喜欢的工作台布局')).toBeTruthy();
}

async function openPreviewLesson(cameraTime: number, currentTime: number, playing = false) {
  vi.spyOn(FirstLessonProgressStore.prototype, 'reset').mockImplementationOnce(() => (
    new FirstLessonProgressStore(localStorage).save({
      currentStep: 'start-preview', hasStartedPreview: false, completed: false,
    })
  ));
  const lesson = renderLesson({
    ...entranceDocument,
    statements: [...entranceDocument.statements, {
      id: 'focus', time: cameraTime, type: 'camera',
      params: { mode: 'focus', target: 'anon', targetPart: 'head' },
    }],
  }, currentTime);
  lesson.setPlaying(playing);
  await openLayoutChooser();
  fireEvent.click(screen.getByRole('button', { name: '使用此布局，继续教程' }));
  return lesson;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(checkWebGalAssetSourceReadiness).mockResolvedValue({
    status: 'found',
    rootPath: '/assets',
    figurePath: '/assets/figure',
    modelEntryPath: '/assets/figure/anon/model.json',
    modelEntryRelativePath: 'anon/model.json',
    runtimeFamily: 'cubism2',
  });
  localStorage.clear();
  settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    top: 100, left: 100, right: 300, bottom: 140, width: 200, height: 40,
    x: 100, y: 100, toJSON: () => ({}),
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  settingsManager.set('workbenchTimelineLayoutMode', 'tracks');
});

describe('FirstLessonController regressions', () => {
  it.each([0, 5])('checks the actual CTI against camera focus at %s seconds', async (cameraTime) => {
    const lesson = await openPreviewLesson(cameraTime, cameraTime + 2);
    expect(screen.getByText('把 CTI 移到镜头对焦之前')).toBeTruthy();
    expect(screen.getByText('第 13 / 13 步')).toBeTruthy();
    fireEvent.pointerDown(document.querySelector('.timeline-ruler')!);
    expect(screen.getByText('把 CTI 移到镜头对焦之前')).toBeTruthy();
    lesson.setTime(cameraTime);
    if (cameraTime > 0) {
      expect(screen.getByText('把 CTI 移到镜头对焦之前')).toBeTruthy();
      lesson.setTime(cameraTime - 1);
    }
    expect(screen.getByText('播放你的场景')).toBeTruthy();
    lesson.setTime(cameraTime + 1);
    expect(screen.getByText('把 CTI 移到镜头对焦之前')).toBeTruthy();
    expect(new FirstLessonProgressStore(localStorage).load().completed).toBe(false);
  });

  it('requires a new playback from before focus even when playback was already running', async () => {
    const lesson = await openPreviewLesson(5, 6, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(new FirstLessonProgressStore(localStorage).load().completed).toBe(false);
    lesson.setPlaying(false);
    lesson.setPlaying(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(new FirstLessonProgressStore(localStorage).load().completed).toBe(false);
    lesson.setPlaying(false);
    lesson.setTime(4);
    lesson.setPlaying(true);
    lesson.setTime(6);
    expect(screen.getByText('播放你的场景')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(new FirstLessonProgressStore(localStorage).load().completed).toBe(true);
  });

  it('cancels completion when the valid preview is paused before one second', async () => {
    const lesson = await openPreviewLesson(5, 4);
    expect(screen.getByText('播放你的场景')).toBeTruthy();
    lesson.setPlaying(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    lesson.setPlaying(false);
    lesson.setTime(6);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('把 CTI 移到镜头对焦之前')).toBeTruthy();
    expect(new FirstLessonProgressStore(localStorage).load().completed).toBe(false);
  });

  it('explains a failed asset check and opens the preparation guide', async () => {
    vi.mocked(checkWebGalAssetSourceReadiness).mockResolvedValue({
      status: 'needs_reselect',
      code: 'model-texture-missing',
    });
    renderLesson();

    fireEvent.click(screen.getByText('Start'));
    fireEvent.click(screen.getByRole('button', { name: '是，我使用 WebGAL' }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText(/模型引用的纹理图片不完整/)).toBeTruthy();
    const helpToggle = screen.getByRole('button', { name: '如何准备素材' });
    fireEvent.click(helpToggle);
    expect(helpToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: '素材目录示例' })).toBeTruthy();
    expect(screen.getByText('...\\public\\games\\<项目名>\\game')).toBeTruthy();
    expect(screen.getByText('...\\public\\games\\<项目名>\\game\\figure')).toBeTruthy();
    expect(screen.getByText(/选择 figure\/ 的上一层 game\/ 目录/)).toBeTruthy();
  });

  it('explains that the selected folder must be the parent of figure', async () => {
    vi.mocked(checkWebGalAssetSourceReadiness).mockResolvedValue({
      status: 'needs_reselect',
      code: 'missing-figure-directory',
    });
    renderLesson();

    fireEvent.click(screen.getByText('Start'));
    fireEvent.click(screen.getByRole('button', { name: '是，我使用 WebGAL' }));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText(/不要选 figure\/ 本身/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '如何准备素材' }));
    expect(screen.getByText('...\\public\\games\\<项目名>\\game')).toBeTruthy();
    expect(screen.getByText('...\\public\\games\\<项目名>')).toBeTruthy();
    expect(screen.getByText('...\\public\\games\\<项目名>\\game\\figure')).toBeTruthy();
  });

  it('previews layout changes without rendering the choice dialog again or blurring the workspace', async () => {
    renderLesson();
    await openLayoutChooser();
    const dialog = screen.getByRole('dialog');
    const dialogRenders = vi.mocked(useModalDialog).mock.calls.length;
    const list = screen.getByRole('radio', { name: /剧本动作优先/ });
    list.focus();
    fireEvent.click(list);
    expect(settingsManager.get('workbenchTimelineLayoutMode')).toBe('list');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((list as HTMLInputElement).checked).toBe(true);
    expect(document.activeElement).toBe(list);
    expect(vi.mocked(useModalDialog).mock.calls.length).toBe(dialogRenders);
    expect(dialog.parentElement?.classList.contains('fl-lesson-modal-layer--layout')).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /轨道编辑优先/ }));
    expect(settingsManager.get('workbenchTimelineLayoutMode')).toBe('tracks');
    expect((list as HTMLInputElement).checked).toBe(false);
    expect(vi.mocked(useModalDialog).mock.calls.length).toBe(dialogRenders);
  });

  it('advances after a short playback once the character appears, even after playback stops', async () => {
    const lesson = renderLesson(entranceDocument);
    await openLayoutChooser();
    fireEvent.click(screen.getByRole('button', { name: '使用此布局，继续教程' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByText('按空格播放场景')).toBeTruthy();
    lesson.setPlaying(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.getByText('按空格播放场景')).toBeTruthy();
    lesson.showCharacter();
    lesson.setPlaying(false);
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    }
    expect(screen.getByText('放入一张环境画面')).toBeTruthy();
  });

  it('requires playback as well as the character appearing on stage', async () => {
    const lesson = renderLesson(entranceDocument);
    await openLayoutChooser();
    fireEvent.click(screen.getByRole('button', { name: '使用此布局，继续教程' }));
    lesson.showCharacter();
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    }
    expect(screen.getByText('按空格播放场景')).toBeTruthy();
    lesson.setPlaying(true);
    expect(screen.getByText('放入一张环境画面')).toBeTruthy();
  });

  it('continues to the background lesson when entrance playback lasts over one second', async () => {
    const lesson = renderLesson(entranceDocument);
    await openLayoutChooser();
    fireEvent.click(screen.getByRole('button', { name: '使用此布局，继续教程' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    lesson.showCharacter();
    lesson.setPlaying(true);
    for (let tick = 0; tick < 8; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    }

    expect(screen.queryByText('教程已完成')).toBeNull();
    expect(screen.getByText('放入一张环境画面')).toBeTruthy();
    expect(new FirstLessonProgressStore(localStorage).load()).toMatchObject({
      currentStep: 'insert-environment-background',
      hasStartedPreview: false,
      completed: false,
    });
  });

  it('keeps model validation stable when unrelated scene statements change', async () => {
    const lesson = renderLesson(entranceDocument);
    await openLayoutChooser();
    fireEvent.click(screen.getByRole('button', { name: '使用此布局，继续教程' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(checkFirstLessonLive2DModelReadiness).toHaveBeenCalledTimes(1);
    lesson.updateDocument({ ...entranceDocument, meta: { ...entranceDocument.meta, title: 'Edited' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(checkFirstLessonLive2DModelReadiness).toHaveBeenCalledTimes(1);
    lesson.updateDocument({ ...entranceDocument, meta: {
      ...entranceDocument.meta, characters: [{ id: 'anon', name: 'Anon', model: 'figure/replacement.model3.json' }],
    } });
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(checkFirstLessonLive2DModelReadiness).toHaveBeenCalledTimes(2);
  });

  it('does not return to the character entrance step after later scene updates', async () => {
    const lesson = renderLesson(entranceDocument);
    await openLayoutChooser();
    fireEvent.click(screen.getByRole('button', { name: '使用此布局，继续教程' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });

    lesson.setPlaying(true);
    lesson.showCharacter();
    lesson.setPlaying(false);
    for (let tick = 0; tick < 7; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    }
    expect(screen.getByText('放入一张环境画面')).toBeTruthy();

    const documentWithEnvironment: CurrentSceneDocument = {
      ...entranceDocument,
      statements: [
        ...entranceDocument.statements,
        {
          id: 'environment-background',
          time: 0,
          type: 'environmentLayer',
          params: { mode: 'set', layerId: 'background', file: 'background/bg.png' },
        },
      ],
    };
    lesson.updateDocument(documentWithEnvironment);
    expect(screen.getByText('添加一句对白')).toBeTruthy();

    // Moving the timeline can temporarily make the entered character invisible.
    lesson.hideCharacter();
    lesson.updateDocument({
      ...documentWithEnvironment,
      meta: { ...documentWithEnvironment.meta, title: 'Lesson updated' },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });

    expect(screen.getByText('添加一句对白')).toBeTruthy();
    expect(screen.queryByText('按空格播放场景')).toBeNull();
  });
});
