/**
 * @vitest-environment jsdom
 */
import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  getGuidePresentation,
  isMotionPlaybackKey,
  registerMotionPlaybackListeners,
  resolveFirstLessonGuideStep,
  type ResolveFirstLessonGuideStepInput,
} from '../ui/onboarding/FirstLessonController';

const baseInput = (
  overrides: Partial<ResolveFirstLessonGuideStepInput>,
): ResolveFirstLessonGuideStepInput => ({
  firstUnmetStep: 'create-character',
  modelStatus: 'idle',
  hasEntranceStatement: false,
  hasEnvironmentStatement: false,
  hasDialogueStatement: false,
  hasAnyMotionStatement: false,
  hasCameraFocusStatement: false,
  hasTunedCameraFocusPart: false,
  motionCtiPositioned: false,
  characterDirectoryVisible: false,
  inspectorPickerOpen: false,
  assetBrowserVisible: false,
  blankMenuVisible: false,
  dialogueFieldVisible: false,
  dialogueBlockVisible: false,
  dialogueBlockSelected: false,
  motionBlockVisible: false,
  motionBlockSelected: false,
  motionPickerVisible: false,
  cameraBlockVisible: false,
  cameraBlockSelected: false,
  cameraFocusPartMenuVisible: false,
  environmentBlockVisible: false,
  environmentBlockSelected: false,
  environmentImageFieldVisible: false,
  ...overrides,
});

describe('resolveFirstLessonGuideStep', () => {
  it('spotlights inspector navigation one interaction at a time', () => {
    expect(getGuidePresentation('open-character-panel', 'idle')).toMatchObject({
      title: '进入角色管理',
      selector: '.inspector-view-picker',
    });
    expect(getGuidePresentation('switch-to-characters', 'idle')).toMatchObject({
      title: '选择角色管理',
      selector: '.inspector-view-picker__menu [role="menuitemradio"][aria-label^="角色管理"]',
    });
    expect(getGuidePresentation('add-character', 'idle').selector)
      .toBe('[data-testid="character-add-button"]');
  });

  it('uses transient navigation targets without persisting them as business steps', () => {
    expect(resolveFirstLessonGuideStep(baseInput({}))).toBe('open-character-panel');
    expect(resolveFirstLessonGuideStep(baseInput({ inspectorPickerOpen: true })))
      .toBe('switch-to-characters');
    expect(resolveFirstLessonGuideStep(baseInput({ characterDirectoryVisible: true })))
      .toBe('add-character');
  });

  it('waits for exact model validation and follows the resource browser', () => {
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'select-character-model',
      characterDirectoryVisible: true,
      modelStatus: 'checking',
    }))).toBe('validate-model');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'select-character-model',
      characterDirectoryVisible: true,
      assetBrowserVisible: true,
    }))).toBe('pick-model-file');

    expect(getGuidePresentation('pick-model-file', 'idle')).toMatchObject({
      selector: '[role="dialog"][aria-labelledby="asset-browser-title"]',
      description: '在 figure 中找到角色模型，选择 model.json、*.model.json 或 *.model3.json。',
    });
  });

  it('guides both blank-menu insertions and dialogue editing in order', () => {
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-character-entrance',
      blankMenuVisible: true,
    }))).toBe('insert-entrance');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-character-entrance',
      hasEntranceStatement: true,
    }))).toBe('play-entrance');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'add-and-edit-dialogue',
      blankMenuVisible: true,
    }))).toBe('insert-dialogue');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'add-and-edit-dialogue',
      hasDialogueStatement: true,
      dialogueFieldVisible: true,
    }))).toBe('edit-dialogue');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'add-and-edit-dialogue',
      hasDialogueStatement: true,
      dialogueBlockVisible: true,
      dialogueBlockSelected: true,
    }))).toBe('open-action-panel');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'add-and-edit-dialogue',
      hasDialogueStatement: true,
      dialogueBlockVisible: true,
      dialogueBlockSelected: true,
      inspectorPickerOpen: true,
    }))).toBe('switch-to-actions');
  });

  it('guides inserting an environment background between the entrance and the dialogue', () => {
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-environment-background',
    }))).toBe('right-click-for-environment');
    expect(getGuidePresentation('right-click-for-environment', 'idle')).toMatchObject({
      selector: '[data-tutorial-target="timeline-blank-start"]',
      title: '放入一张环境画面',
      step: 5,
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-environment-background',
      blankMenuVisible: true,
    }))).toBe('insert-environment');
    expect(getGuidePresentation('insert-environment', 'idle').selector)
      .toBe('[data-testid="timeline-blank-insert-menu"] [data-block-id="environment.set-background"]');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-environment-background',
      hasEnvironmentStatement: true,
    }))).toBe('select-environment-block');
    expect(getGuidePresentation('select-environment-block', 'idle')).toMatchObject({
      selector: '[data-testid="timeline-track-block"][data-semantic-type="environmentLayer"]',
      title: '选中环境语句',
      step: 5,
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-environment-background',
      hasEnvironmentStatement: true,
      environmentBlockVisible: true,
      environmentBlockSelected: true,
    }))).toBe('open-environment-panel');
    expect(getGuidePresentation('open-environment-panel', 'idle')).toMatchObject({
      selector: '.inspector-view-picker > summary',
      title: '打开环境编辑视图',
      step: 5,
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-environment-background',
      hasEnvironmentStatement: true,
      environmentBlockVisible: true,
      environmentBlockSelected: true,
      inspectorPickerOpen: true,
    }))).toBe('switch-to-environment-actions');
    expect(getGuidePresentation('switch-to-environment-actions', 'idle')).toMatchObject({
      selector: '.inspector-view-picker__menu [role="menuitemradio"][aria-label^="剧本动作"]',
      title: '进入剧本动作',
      step: 5,
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-environment-background',
      hasEnvironmentStatement: true,
      environmentBlockVisible: true,
      environmentBlockSelected: true,
      environmentImageFieldVisible: true,
    }))).toBe('pick-environment-image');
    expect(getGuidePresentation('pick-environment-image', 'idle')).toMatchObject({
      selector: '[aria-label="打开资源浏览器"]',
      title: '选择一张背景图片',
      step: 5,
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-environment-background',
      hasEnvironmentStatement: true,
      assetBrowserVisible: true,
    }))).toBe('choose-environment-image');
    expect(getGuidePresentation('choose-environment-image', 'idle')).toMatchObject({
      selector: '[role="dialog"][aria-labelledby="asset-browser-title"]',
      title: '选中背景图片',
      step: 5,
    });
  });

  it('guides stretching and dragging the dialogue block after editing it', () => {
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'resize-dialogue-duration',
      dialogueBlockVisible: true,
    }))).toBe('stretch-dialogue');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'resize-dialogue-duration',
      dialogueBlockVisible: false,
    }))).toBe('select-dialogue');
    expect(getGuidePresentation('stretch-dialogue', 'idle')).toMatchObject({
      selector: '[data-testid="timeline-track-block"][aria-label="对话"] [data-testid="timeline-resize-handle"]',
      title: '拉伸修改对白时长',
      step: 7,
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'move-dialogue-time',
      dialogueBlockVisible: true,
    }))).toBe('move-dialogue-time');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'move-dialogue-time',
      dialogueBlockVisible: false,
    }))).toBe('select-dialogue');
    expect(getGuidePresentation('move-dialogue-time', 'idle')).toMatchObject({
      selector: '[data-testid="timeline-track-block"][aria-label="对话"]',
      title: '拖动改变对白时间',
      step: 8,
    });
  });

  it('guides Live2D motion insertion after the character entrance', () => {
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'add-live2d-motion',
    }))).toBe('right-click-for-motion');
    expect(getGuidePresentation('right-click-for-motion', 'idle')).toMatchObject({
      selector: '[data-tutorial-target="timeline-blank-after-entrance"]',
      description: '在高亮的登场位置空白处点击右键，准备添加角色动作。动作不能放在“角色登场”之前，最多与它平齐。',
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'add-live2d-motion',
      blankMenuVisible: true,
    }))).toBe('insert-motion');
    expect(getGuidePresentation('insert-motion', 'idle').selector)
      .toBe('[data-testid="timeline-blank-insert-menu"] [data-block-id="character.performance.motion"]');
    expect(getGuidePresentation('insert-motion', 'idle').description)
      .toContain('角色登场');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'add-live2d-motion',
      hasAnyMotionStatement: true,
      motionBlockVisible: true,
      motionBlockSelected: false,
    }))).toBe('select-motion-block');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'add-live2d-motion',
      hasAnyMotionStatement: true,
      motionBlockVisible: true,
      motionBlockSelected: true,
    }))).toBe('open-motion-picker');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'add-live2d-motion',
      hasAnyMotionStatement: true,
      motionBlockVisible: true,
      motionBlockSelected: true,
      motionPickerVisible: true,
    }))).toBe('choose-motion');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'preview-live2d-motion',
    }))).toBe('position-motion-cti');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'preview-live2d-motion',
      motionCtiPositioned: true,
    }))).toBe('play-motion');
    expect(getGuidePresentation('play-motion', 'idle')).toMatchObject({
      selector: '.btn--play',
      allowWorkspaceInteraction: true,
      showSpotlight: false,
    });
  });

  it('guides camera focus and filter insertion after the motion preview', () => {
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-camera-focus',
    }))).toBe('right-click-for-camera');
    expect(getGuidePresentation('right-click-for-camera', 'idle')).toMatchObject({
      selector: '[data-tutorial-target="timeline-blank-after-entrance"]',
      title: '添加镜头对焦',
      step: 11,
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'insert-camera-focus',
      blankMenuVisible: true,
    }))).toBe('insert-camera-focus');
    expect(getGuidePresentation('insert-camera-focus', 'idle').selector)
      .toBe('[data-testid="timeline-blank-insert-menu"] [data-block-id="camera.focus"]');

    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'tune-camera-focus-part',
    }))).toBe('select-camera-focus');
    expect(getGuidePresentation('select-camera-focus', 'idle')).toMatchObject({
      selector: '[data-testid="timeline-track-block"][data-semantic-type="camera"]',
      step: 12,
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'tune-camera-focus-part',
      cameraBlockVisible: true,
      cameraBlockSelected: false,
    }))).toBe('select-camera-focus');
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'tune-camera-focus-part',
      cameraBlockVisible: true,
      cameraBlockSelected: true,
    }))).toBe('choose-camera-focus-part');
    expect(getGuidePresentation('choose-camera-focus-part', 'idle')).toMatchObject({
      selector: '[aria-label="对焦部位"]',
      title: '把对焦部位改成头部',
      step: 12,
    });
    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'tune-camera-focus-part',
      cameraBlockVisible: true,
      cameraBlockSelected: true,
      cameraFocusPartMenuVisible: true,
    }))).toBe('choose-camera-focus-part-menu');
    expect(getGuidePresentation('choose-camera-focus-part-menu', 'idle')).toMatchObject({
      selector: '[role="listbox"][aria-label="对焦部位选项"]',
      title: '选择“头部”',
      step: 12,
    });

    expect(resolveFirstLessonGuideStep(baseInput({
      firstUnmetStep: 'start-preview',
    }))).toBe('start-preview');
    expect(getGuidePresentation('start-preview', 'idle')).toMatchObject({
      selector: '.btn--play',
      step: 12,
    });
  });
});

describe('motion playback shortcut', () => {
  it('accepts global Space and protects text entry and IME events', () => {
    const globalSpace = {
      code: 'Space',
      isComposing: false,
      target: null,
    } as unknown as KeyboardEvent;
    expect(isMotionPlaybackKey(globalSpace)).toBe(true);

    const inputSpace = {
      code: 'Space',
      isComposing: false,
      target: {
        closest: (selector: string) => selector.split(',').some((candidate) => candidate.trim() === 'input')
          ? {}
          : null,
      },
    } as unknown as KeyboardEvent;
    expect(isMotionPlaybackKey(inputSpace)).toBe(false);

    const composingSpace = {
      code: 'Space',
      isComposing: true,
      target: null,
    } as unknown as KeyboardEvent;
    expect(isMotionPlaybackKey(composingSpace)).toBe(false);
  });

  it('registers the play-motion DOM listeners and handles only an unmodified global Space', () => {
    const playButton = document.createElement('button');
    playButton.className = 'btn--play';
    document.body.append(playButton);
    const requestPlayback = vi.fn();
    const cleanup = registerMotionPlaybackListeners(requestPlayback);

    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(requestPlayback).toHaveBeenCalledTimes(1);

    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey'] as const) {
      fireEvent.keyDown(document.body, { key: ' ', code: 'Space', [modifier]: true });
    }
    expect(requestPlayback).toHaveBeenCalledTimes(1);

    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: ' ', code: 'Space' });
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space', isComposing: true });
    expect(requestPlayback).toHaveBeenCalledTimes(1);

    fireEvent.click(playButton);
    expect(requestPlayback).toHaveBeenCalledTimes(2);

    cleanup();
    fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
    expect(requestPlayback).toHaveBeenCalledTimes(2);
  });
});
