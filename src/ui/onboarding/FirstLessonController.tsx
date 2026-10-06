import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import type { IProjectOpenWorkflow } from '../../api/interfaces/IProjectOpenWorkflow';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import { getCubismPixiSdkStatus } from '../../engine/CubismPixiSdk';
import {
  evaluateFirstLessonCompletion,
  FirstLessonProgressStore,
  FirstLessonProjectService,
  checkFirstLessonLive2DModelReadiness,
  checkWebGalAssetSourceReadiness,
  type FirstLessonBusinessStep,
  type FirstLessonProgressState,
  type WebGalAssetSourceFileAccess,
} from '../../services/onboarding';
import type { IFileAccess } from '../../services/io/IFileAccess';
import { IconCheck, IconInfo, IconTarget, IconX } from '../icons';
import { useModalDialog } from '../hooks/useModalDialog';
import { SpotlightOverlay } from './SpotlightOverlay';
import './firstLesson.css';

type LessonPhase =
  | 'idle'
  | 'intro'
  | 'asset-checking'
  | 'asset-found'
  | 'asset-setup'
  | 'creating-project'
  | 'guiding'
  | 'completed'
  | 'error';

type ReadinessStatus = 'idle' | 'checking' | 'found' | 'needs_reselect';

export type FirstLessonGuideStep =
  | 'open-character-panel'
  | 'switch-to-characters'
  | 'add-character'
  | 'validate-model'
  | 'select-model'
  | 'pick-model-file'
  | 'right-click-for-entrance'
  | 'insert-entrance'
  | 'play-entrance'
  | 'right-click-for-environment'
  | 'insert-environment'
  | 'select-environment-block'
  | 'open-environment-panel'
  | 'switch-to-environment-actions'
  | 'pick-environment-image'
  | 'choose-environment-image'
  | 'right-click-for-dialogue'
  | 'insert-dialogue'
  | 'select-dialogue'
  | 'open-action-panel'
  | 'switch-to-actions'
  | 'edit-dialogue'
  | 'right-click-for-motion'
  | 'insert-motion'
  | 'select-motion-block'
  | 'open-motion-picker'
  | 'choose-motion'
  | 'position-motion-cti'
  | 'play-motion'
  | 'right-click-for-camera'
  | 'insert-camera-focus'
  | 'select-camera-focus'
  | 'choose-camera-focus-part'
  | 'choose-camera-focus-part-menu'
  | 'stretch-dialogue'
  | 'move-dialogue-time'
  | 'start-preview';

interface GuideDomSnapshot {
  characterDirectoryVisible: boolean;
  inspectorPickerOpen: boolean;
  blankMenuVisible: boolean;
  dialogueFieldVisible: boolean;
  dialogueBlockVisible: boolean;
  dialogueBlockSelected: boolean;
  motionBlockVisible: boolean;
  motionBlockSelected: boolean;
  motionPickerVisible: boolean;
  cameraBlockVisible: boolean;
  cameraBlockSelected: boolean;
  cameraFocusPartMenuVisible: boolean;
  environmentBlockVisible: boolean;
  environmentBlockSelected: boolean;
  environmentImageFieldVisible: boolean;
  assetBrowserVisible: boolean;
}

export interface ResolveFirstLessonGuideStepInput extends GuideDomSnapshot {
  firstUnmetStep: FirstLessonBusinessStep;
  modelStatus: ReadinessStatus;
  hasEntranceStatement: boolean;
  hasEnvironmentStatement: boolean;
  hasDialogueStatement: boolean;
  hasAnyMotionStatement: boolean;
  hasCameraFocusStatement: boolean;
  hasTunedCameraFocusPart: boolean;
  motionCtiPositioned: boolean;
}

const FIRST_LESSON_GUIDE_TOTAL_STEPS = 12;

const MOTION_PLAYBACK_IGNORED_TARGET = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '.monaco-editor',
  '.monaco-editor *',
  'button',
  'a[href]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="separator"]',
  '[role="tab"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="button"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export const isMotionPlaybackKey = (event: KeyboardEvent): boolean => {
  if (
    event.code !== 'Space'
    || event.isComposing
    || event.ctrlKey
    || event.altKey
    || event.metaKey
    || event.shiftKey
  ) return false;
  const target = event.target as Element | null;
  return !target?.closest?.(MOTION_PLAYBACK_IGNORED_TARGET);
};

export const registerMotionPlaybackListeners = (onPlaybackRequested: () => void): (() => void) => {
  const playButton = document.querySelector<HTMLElement>('.btn--play');
  const handlePlayClick = () => onPlaybackRequested();
  const handlePlayKey = (event: KeyboardEvent) => {
    if (isMotionPlaybackKey(event)) onPlaybackRequested();
  };
  playButton?.addEventListener('click', handlePlayClick, { once: true });
  window.addEventListener('keydown', handlePlayKey, true);
  return () => {
    playButton?.removeEventListener('click', handlePlayClick);
    window.removeEventListener('keydown', handlePlayKey, true);
  };
};

interface GuidePresentation {
  selector: string;
  title: string;
  description: string;
  step: number;
  allowTargetInteraction?: boolean;
  allowWorkspaceInteraction?: boolean;
  showSpotlight?: boolean;
  padding?: number;
  status?: { label: string; tone: 'checking' | 'success' | 'warning' };
}

interface FirstLessonControllerServices {
  fileAccess: IFileAccess;
  projectOpenWorkflow: Pick<IProjectOpenWorkflow, 'createProjectAndLoadDefaultScene'>;
  projectResources: {
    resolveForRead(reference: string): Promise<string>;
  };
  characterAdapter: {
    hasCharacter(id: string): boolean;
  };
  playbackStore: {
    readonly playing: boolean;
    subscribe(listener: () => void): () => void;
  };
}

export interface FirstLessonControls {
  startFirstLesson: () => void;
}

export interface FirstLessonControllerProps extends FirstLessonControllerServices {
  semanticDocument: CurrentSceneDocument | null;
  externalLibraryPaths: readonly string[];
  defaultProjectDirectory: string;
  children: (controls: FirstLessonControls) => React.ReactNode;
}

const EMPTY_MODEL_AVAILABILITY: Readonly<Record<string, boolean>> = Object.freeze({});

const createSafeBrowserStorage = () => ({
  getItem: (key: string) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // The tutorial remains usable for the current session when persistence is unavailable.
    }
  },
  removeItem: (key: string) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage failures for the same reason as setItem.
    }
  },
});

const normalizePathForComparison = (value: string | undefined) => (
  (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
);

const isVisible = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
};

const readGuideDomSnapshot = (_refreshKey: {
  readonly domRevision: number;
  readonly phase: LessonPhase;
  readonly semanticDocument: CurrentSceneDocument | null;
}): GuideDomSnapshot => ({
  characterDirectoryVisible: isVisible('[data-testid="character-directory"]'),
  inspectorPickerOpen: document.querySelector('.inspector-view-picker')?.hasAttribute('open') ?? false,
  assetBrowserVisible: isVisible('[role="dialog"][aria-labelledby="asset-browser-title"]'),
  blankMenuVisible: isVisible('[data-testid="timeline-blank-insert-menu"]'),
  dialogueFieldVisible: isVisible('[data-testid="action-param-text"]'),
  dialogueBlockVisible: isVisible('[data-testid="timeline-track-block"][aria-label="对话"]'),
  dialogueBlockSelected: isVisible('[data-testid="timeline-track-block"][aria-label="对话"][aria-pressed="true"]'),
  motionBlockVisible: isVisible('[data-testid="timeline-track-block"][data-semantic-type="characterPerformance"]'),
  motionBlockSelected: isVisible('[data-testid="timeline-track-block"][data-semantic-type="characterPerformance"][aria-pressed="true"]'),
  motionPickerVisible: isVisible('.searchable-select-overlay [role="listbox"][aria-label="可选项"]'),
  cameraBlockVisible: isVisible('[data-testid="timeline-track-block"][data-semantic-type="camera"]'),
  cameraBlockSelected: isVisible('[data-testid="timeline-track-block"][data-semantic-type="camera"][aria-pressed="true"]'),
  cameraFocusPartMenuVisible: isVisible('[role="listbox"][aria-label="对焦部位选项"]'),
  environmentBlockVisible: isVisible('[data-testid="timeline-track-block"][data-semantic-type="environmentLayer"]'),
  environmentBlockSelected: isVisible('[data-testid="timeline-track-block"][data-semantic-type="environmentLayer"][aria-pressed="true"]'),
  environmentImageFieldVisible: isVisible('[placeholder="选择背景图片..."]'),
});

const resolveCharacterPanelStep = (snapshot: GuideDomSnapshot): FirstLessonGuideStep | null => {
  if (snapshot.characterDirectoryVisible) return null;
  return snapshot.inspectorPickerOpen ? 'switch-to-characters' : 'open-character-panel';
};

export function resolveFirstLessonGuideStep(
  input: ResolveFirstLessonGuideStepInput,
): FirstLessonGuideStep {
  const characterPanelStep = resolveCharacterPanelStep(input);

  if (input.firstUnmetStep === 'create-character') {
    return characterPanelStep ?? 'add-character';
  }

  if (input.firstUnmetStep === 'select-character-model') {
    if (input.assetBrowserVisible) return 'pick-model-file';
    if (characterPanelStep) return characterPanelStep;
    return input.modelStatus === 'checking' ? 'validate-model' : 'select-model';
  }

  if (input.firstUnmetStep === 'insert-character-entrance') {
    if (input.hasEntranceStatement) return 'play-entrance';
    return input.blankMenuVisible ? 'insert-entrance' : 'right-click-for-entrance';
  }

  if (input.firstUnmetStep === 'insert-environment-background') {
    if (!input.hasEnvironmentStatement) {
      return input.blankMenuVisible ? 'insert-environment' : 'right-click-for-environment';
    }
    if (input.assetBrowserVisible) {
      return 'choose-environment-image';
    }
    if (!input.environmentBlockVisible || !input.environmentBlockSelected) return 'select-environment-block';
    if (input.environmentImageFieldVisible) return 'pick-environment-image';
    return input.inspectorPickerOpen ? 'switch-to-environment-actions' : 'open-environment-panel';
  }

  if (input.firstUnmetStep === 'add-and-edit-dialogue') {
    if (!input.hasDialogueStatement) {
      return input.blankMenuVisible ? 'insert-dialogue' : 'right-click-for-dialogue';
    }
    if (input.dialogueFieldVisible) return 'edit-dialogue';
    if (!input.dialogueBlockVisible || !input.dialogueBlockSelected) return 'select-dialogue';
    return input.inspectorPickerOpen ? 'switch-to-actions' : 'open-action-panel';
  }

  if (input.firstUnmetStep === 'resize-dialogue-duration') {
    return input.dialogueBlockVisible ? 'stretch-dialogue' : 'select-dialogue';
  }

  if (input.firstUnmetStep === 'move-dialogue-time') {
    return input.dialogueBlockVisible ? 'move-dialogue-time' : 'select-dialogue';
  }

  if (input.firstUnmetStep === 'add-live2d-motion') {
    if (!input.hasAnyMotionStatement) {
      return input.blankMenuVisible ? 'insert-motion' : 'right-click-for-motion';
    }
    if (!input.motionBlockVisible || !input.motionBlockSelected) return 'select-motion-block';
    if (input.motionPickerVisible) return 'choose-motion';
    return 'open-motion-picker';
  }

  if (input.firstUnmetStep === 'preview-live2d-motion') {
    return input.motionCtiPositioned ? 'play-motion' : 'position-motion-cti';
  }

  if (input.firstUnmetStep === 'insert-camera-focus') {
    return input.blankMenuVisible ? 'insert-camera-focus' : 'right-click-for-camera';
  }

  if (input.firstUnmetStep === 'tune-camera-focus-part') {
    if (input.cameraFocusPartMenuVisible) return 'choose-camera-focus-part-menu';
    return input.cameraBlockVisible && input.cameraBlockSelected
      ? 'choose-camera-focus-part'
      : 'select-camera-focus';
  }

  return 'start-preview';
}

export const getGuidePresentation = (
  step: FirstLessonGuideStep,
  modelStatus: ReadinessStatus,
): GuidePresentation => {
  switch (step) {
    case 'open-character-panel':
      return {
        selector: '.inspector-view-picker',
        title: '进入角色管理',
        description: '点击右侧的视图切换器，接下来进入角色管理。',
        step: 2,
      };
    case 'switch-to-characters':
      return {
        selector: '.inspector-view-picker__menu [role="menuitemradio"][aria-label^="角色管理"]',
        title: '选择角色管理',
        description: '选择“角色管理”，在这里准备登上舞台的角色。',
        step: 2,
      };
    case 'add-character':
      return {
        selector: '[data-testid="character-add-button"]',
        title: '创建一个角色',
        description: '点击“添加角色”。教程只检查结果，角色仍由你亲自创建。',
        step: 2,
      };
    case 'validate-model':
      return {
        selector: '[aria-label="选择模型文件"]',
        title: '正在检查模型',
        description: '正在确认模型本体、纹理和显示能力。检查完成后会自动继续。',
        step: 3,
        allowTargetInteraction: false,
        status: { label: '正在检查', tone: 'checking' },
      };
    case 'select-model':
      return {
        selector: '[aria-label="选择模型文件"]',
        title: modelStatus === 'needs_reselect' ? '需要重新选择模型' : '为角色选择模型',
        description: modelStatus === 'needs_reselect'
          ? '请选择文件完整的 model.json、*.model.json 或 *.model3.json；拼好模不进入本课。'
          : '点击文件夹按钮，为刚创建的角色选择一个可用的 Live2D 模型。',
        step: 3,
        status: modelStatus === 'needs_reselect'
          ? { label: '需要重新选择', tone: 'warning' }
          : undefined,
      };
    case 'pick-model-file':
      return {
        selector: '[role="dialog"][aria-labelledby="asset-browser-title"]',
        title: '选择模型入口文件',
        description: '在 figure 中找到角色模型，选择 model.json、*.model.json 或 *.model3.json。',
        step: 3,
        padding: 3,
      };
    case 'right-click-for-entrance':
      return {
        selector: '[data-tutorial-target="timeline-blank-start"]',
        title: '让角色登上舞台',
        description: '在高亮的时间轴起点空白处点击右键，打开语句菜单。',
        step: 4,
        padding: 2,
      };
    case 'insert-entrance':
      return {
        selector: '[data-testid="timeline-blank-insert-menu"] [data-block-id="character.enter"]',
        title: '插入角色登场',
        description: '点击“角色登场”，让刚才的模型真正显示在舞台上。',
        step: 4,
        padding: 5,
      };
    case 'play-entrance':
      return {
        selector: '.btn--play',
        title: '按空格播放场景',
        description: '舞台目前是暂停状态。按下空格键开始播放，让角色真正登上舞台。',
        step: 4,
        padding: 7,
        allowWorkspaceInteraction: true,
        showSpotlight: false,
      };
    case 'right-click-for-environment':
      return {
        selector: '[data-tutorial-target="timeline-blank-start"]',
        title: '放入一张环境画面',
        description: '在高亮的时间轴起点空白处点击右键，准备给舞台铺上背景。',
        step: 5,
        padding: 2,
      };
    case 'insert-environment':
      return {
        selector: '[data-testid="timeline-blank-insert-menu"] [data-block-id="environment.set-background"]',
        title: '插入环境画面',
        description: '点击“放入环境画面”，时间轴会创建一条环境语句，稍后为它选择一张背景图片。',
        step: 5,
        padding: 5,
      };
    case 'select-environment-block':
      return {
        selector: '[data-testid="timeline-track-block"][data-semantic-type="environmentLayer"]',
        title: '选中环境语句',
        description: '点击时间轴上的环境语句，在右侧打开它的设置。',
        step: 5,
        padding: 5,
      };
    case 'open-environment-panel':
      return {
        selector: '.inspector-view-picker > summary',
        title: '打开环境编辑视图',
        description: '环境语句已经选中。点击侧栏视图切换器，回到“剧本动作”。',
        step: 5,
      };
    case 'switch-to-environment-actions':
      return {
        selector: '.inspector-view-picker__menu [role="menuitemradio"][aria-label^="剧本动作"]',
        title: '进入剧本动作',
        description: '选择“剧本动作”，在右侧为环境选择一张背景图片。',
        step: 5,
      };
    case 'pick-environment-image':
      return {
        selector: '[aria-label="打开资源浏览器"]',
        title: '选择一张背景图片',
        description: '点击文件夹按钮打开资源浏览器，为环境选择一张背景图片。',
        step: 5,
        padding: 5,
      };
    case 'choose-environment-image':
      return {
        selector: '[role="dialog"][aria-labelledby="asset-browser-title"]',
        title: '选中背景图片',
        description: '在 background 目录里点击一张图片，把它铺成舞台背景。选择完成后会自动进入下一步。',
        step: 5,
        padding: 3,
      };
    case 'right-click-for-dialogue':
      return {
        selector: '[data-tutorial-target="timeline-blank-start"]',
        title: '添加一句对白',
        description: '再次在高亮的时间轴空白处点击右键，准备插入对白。',
        step: 6,
        padding: 2,
      };
    case 'insert-dialogue':
      return {
        selector: '[data-testid="timeline-blank-insert-menu"] [data-block-id="dialogue.basic"]',
        title: '插入对白',
        description: '点击“对话”，时间轴会创建一条默认对白。',
        step: 6,
        padding: 5,
      };
    case 'select-dialogue':
      return {
        selector: '[data-testid="timeline-track-block"][aria-label="对话"]',
        title: '选中刚才的对白',
        description: '点击时间轴上的“对话”语句，在右侧打开它的内容。',
        step: 6,
        padding: 5,
      };
    case 'open-action-panel':
      return {
        selector: '.inspector-view-picker > summary',
        title: '打开对白编辑视图',
        description: '对白已经选中。点击侧栏视图切换器，回到“剧本动作”。',
        step: 6,
      };
    case 'switch-to-actions':
      return {
        selector: '.inspector-view-picker__menu [role="menuitemradio"][aria-label^="剧本动作"]',
        title: '进入剧本动作',
        description: '选择“剧本动作”，在右侧修改刚才创建的对白。',
        step: 6,
      };
    case 'edit-dialogue':
      return {
        selector: '[data-testid="action-param-text"]',
        title: '写下你的第一句台词',
        description: '把“新对白”改成自己的句子，然后点击输入框以外的区域保存。',
        step: 6,
        padding: 5,
        allowWorkspaceInteraction: true,
      };
    case 'stretch-dialogue':
      return {
        selector: '[data-testid="timeline-track-block"][aria-label="对话"] [data-testid="timeline-resize-handle"]',
        title: '拉伸修改对白时长',
        description: '把鼠标移到对白条右侧边缘的把手，指针变成左右箭头后按住并向右拖动，让这句对白显示更久。',
        step: 7,
        padding: 5,
      };
    case 'move-dialogue-time':
      return {
        selector: '[data-testid="timeline-track-block"][aria-label="对话"]',
        title: '拖动改变对白时间',
        description: '按住对白语句左右拖动，把它放到你想让它出现的时刻，松手后位置就改好了。',
        step: 8,
        padding: 5,
      };
    case 'right-click-for-motion':
      return {
        selector: '[data-tutorial-target="timeline-blank-after-entrance"]',
        title: '添加一个 Live2D 动作',
        description: '在高亮的登场位置空白处点击右键，准备添加角色动作。动作不能放在“角色登场”之前，最多与它平齐。',
        step: 9,
        padding: 2,
      };
    case 'insert-motion':
      return {
        selector: '[data-testid="timeline-blank-insert-menu"] [data-block-id="character.performance.motion"]',
        title: '选择角色动作',
        description: '点击“角色动作”，把它放在与“角色登场”平齐或之后的位置，为已经登场的 Live2D 角色添加表演。',
        step: 9,
        padding: 5,
      };
    case 'select-motion-block':
      return {
        selector: '[data-testid="timeline-track-block"][data-semantic-type="characterPerformance"]',
        title: '选中角色动作语句',
        description: '点击刚添加的“角色动作”语句块，在右侧打开动作设置。',
        step: 9,
        padding: 5,
      };
    case 'open-motion-picker':
      return {
        selector: '[data-testid="action-param-motion"]',
        title: '打开动作列表',
        description: '点击动作选择框，查看这个 Live2D 模型提供的动作。',
        step: 9,
        padding: 5,
      };
    case 'choose-motion':
      return {
        selector: '.searchable-select-overlay [role="listbox"][aria-label="可选项"]',
        title: '选择一个动作',
        description: '选择一个非 idle 动作，作为角色在这一刻的表演。',
        step: 9,
        padding: 3,
      };
    case 'position-motion-cti':
      return {
        selector: '.timeline-ruler',
        title: '把 CTI 移到动作之前',
        description: '在时间标尺上点击动作语句之前的位置，让播放从动作前开始。',
        step: 10,
        padding: 2,
      };
    case 'play-motion':
      return {
        selector: '.btn--play',
        title: '播放角色动作',
        description: '按下空格键或点击播放，观看刚才选择的 Live2D 动作。',
        step: 10,
        padding: 7,
        allowWorkspaceInteraction: true,
        showSpotlight: false,
      };
    case 'right-click-for-camera':
      return {
        selector: '[data-tutorial-target="timeline-blank-after-entrance"]',
        title: '添加镜头对焦',
        description: '在高亮的登场位置空白处点击右键，准备为镜头添加一条“对焦”语句。',
        step: 11,
        padding: 2,
      };
    case 'insert-camera-focus':
      return {
        selector: '[data-testid="timeline-blank-insert-menu"] [data-block-id="camera.focus"]',
        title: '插入镜头对焦',
        description: '点击“镜头对焦”，时间轴会创建一条对焦语句，镜头会在这一刻贴近角色。如果找不到，可以在菜单顶部的“镜头”分类里查找。',
        step: 11,
        padding: 5,
      };
    case 'select-camera-focus':
      return {
        selector: '[data-testid="timeline-track-block"][data-semantic-type="camera"]',
        title: '选中镜头对焦语句',
        description: '点击时间轴上的对焦语句，在右侧打开它的设置。',
        step: 12,
        padding: 5,
      };
    case 'choose-camera-focus-part':
      return {
        selector: '[aria-label="对焦部位"]',
        title: '把对焦部位改成头部',
        description: '在右侧找到“对焦部位”，把默认的“胸部”改成“头部”，让镜头对准角色的脸。修改完成后会自动进入下一步。',
        step: 12,
        padding: 5,
      };
    case 'choose-camera-focus-part-menu':
      return {
        selector: '[role="listbox"][aria-label="对焦部位选项"]',
        title: '选择“头部”',
        description: '点击展开列表里的“头部”，镜头就会对准角色的脸。',
        step: 12,
        padding: 3,
      };
    case 'start-preview':
      return {
        selector: '.btn--play',
        title: '播放你的场景',
        description: '点击播放或按下空格键，观看镜头对焦与角色动作。预览真正开始时，这节教程就完成了。',
        step: 12,
        padding: 7,
      };
  }
};

const collectModelReferences = (document: CurrentSceneDocument | null) => {
  const references = new Set<string>();
  for (const character of document?.meta.characters ?? []) {
    if (character.model?.trim()) references.add(character.model.trim());
    for (const variant of character.variants ?? []) {
      if (variant.model?.trim()) references.add(variant.model.trim());
    }
  }
  return [...references];
};

const hasEntranceStatement = (document: CurrentSceneDocument | null, characterId: string | null) => (
  !!characterId && (document?.statements ?? []).some((statement) => (
    statement.type === 'characterPresence'
    && statement.params.mode === 'enter'
    && statement.params.id === characterId
  ))
);

const hasDialogueStatement = (document: CurrentSceneDocument | null) => (
  (document?.statements ?? []).some((statement) => statement.type === 'dialogue')
);

const hasEnvironmentStatement = (document: CurrentSceneDocument | null) => (
  (document?.statements ?? []).some((statement) => statement.type === 'environmentLayer')
);

const hasAnyMotionStatement = (document: CurrentSceneDocument | null, characterId: string | null) => (
  !!characterId && (document?.statements ?? []).some((statement) => (
    statement.type === 'characterPerformance' && statement.params.target === characterId
  ))
);

const hasCameraFocusStatement = (document: CurrentSceneDocument | null) => (
  (document?.statements ?? []).some((statement) => (
    statement.type === 'camera' && statement.params.mode === 'focus'
  ))
);

const hasTunedCameraFocusPart = (
  document: CurrentSceneDocument | null,
  baselines: Readonly<Record<string, string>>,
) => (
  (document?.statements ?? []).some((statement) => {
    if (statement.type !== 'camera' || statement.params.mode !== 'focus') return false;
    const baseline = baselines[statement.id];
    if (!baseline) return false;
    const current = typeof statement.params.targetPart === 'string'
      ? statement.params.targetPart.trim()
      : '';
    return !!current && current !== baseline;
  })
);

const isRuntimeFamilyAvailable = (runtimeFamily: 'cubism2' | 'cubism3-plus') => (
  runtimeFamily === 'cubism2' || getCubismPixiSdkStatus().available
);

const LessonDialog: React.FC<{
  eyebrow: string;
  title: string;
  description: string;
  onClose: () => void;
  closeLabel?: string;
  icon?: 'target' | 'success' | 'info';
  celebration?: boolean;
  status?: { label: string; tone: 'checking' | 'success' | 'warning' };
  children?: React.ReactNode;
}> = ({ eyebrow, title, description, onClose, closeLabel = '关闭教程', icon = 'target', celebration = false, status, children }) => {
  const dialogRef = useModalDialog(onClose);
  const Icon = icon === 'success' ? IconCheck : icon === 'info' ? IconInfo : IconTarget;

  return createPortal(
    <div className="fl-lesson-modal-layer">
      <div
        ref={dialogRef}
        className={`fl-lesson-dialog${celebration ? ' fl-lesson-dialog--celebration' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-lesson-dialog-title"
        tabIndex={-1}
      >
        {celebration && (
          <div className="fl-lesson-confetti" aria-hidden="true">
            {Array.from({ length: 10 }, (_, index) => <span key={index} />)}
          </div>
        )}
        <div className="fl-lesson-dialog__header">
          <span className="fl-lesson-dialog__eyebrow">{eyebrow}</span>
          <button
            type="button"
            className="btn btn--icon fl-lesson-dialog__close"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
          >
            <IconX width={15} height={15} />
          </button>
        </div>
        <div className="fl-lesson-dialog__title-row">
          <span className="fl-lesson-dialog__icon" aria-hidden="true">
            <Icon width={20} height={20} />
          </span>
          <div className="fl-lesson-dialog__copy">
            <h2 id="first-lesson-dialog-title">{title}</h2>
            <p>{description}</p>
          </div>
        </div>
        {status && (
          <div className="fl-lesson-dialog__status" data-tone={status.tone} role="status">
            {status.tone === 'checking' && <span className="fl-lesson-spinner" aria-hidden="true" />}
            <span>{status.label}</span>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
};

export const FirstLessonController: React.FC<FirstLessonControllerProps> = ({
  semanticDocument,
  externalLibraryPaths,
  defaultProjectDirectory,
  fileAccess,
  projectOpenWorkflow,
  projectResources,
  characterAdapter,
  playbackStore,
  children,
}) => {
  const progressStore = useMemo(
    () => new FirstLessonProgressStore(createSafeBrowserStorage()),
    [],
  );
  const [progress, setProgress] = useState<FirstLessonProgressState>(() => progressStore.load());
  const [phase, setPhase] = useState<LessonPhase>('idle');
  const [isWebGalAuthor, setIsWebGalAuthor] = useState<boolean | null>(null);
  const [assetStatus, setAssetStatus] = useState<ReadinessStatus>('idle');
  const [modelStatus, setModelStatus] = useState<ReadinessStatus>('idle');
  const [modelAvailability, setModelAvailability] = useState<Readonly<Record<string, boolean>>>(EMPTY_MODEL_AVAILABILITY);
  const [errorMessage, setErrorMessage] = useState('');
  const [domRevision, setDomRevision] = useState(0);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const [modelCheckRevision, setModelCheckRevision] = useState(0);
  const [confirmedVisibleCharacterIds, setConfirmedVisibleCharacterIds] = useState<readonly string[]>([]);
  const [hasPlayedCharacterEntrance, setHasPlayedCharacterEntrance] = useState(false);
  const [motionCtiPositioned, setMotionCtiPositioned] = useState(false);
  const [motionPlaybackRequested, setMotionPlaybackRequested] = useState(false);
  const [hasPreviewedLive2DMotion, setHasPreviewedLive2DMotion] = useState(false);
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false);
  const operationTokenRef = useRef(0);
  const assetFingerprintRef = useRef('');
  const completionTimerRef = useRef<number | null>(null);
  const motionPreviewTimerRef = useRef<number | null>(null);
  const [dialogueBaselines, setDialogueBaselines] = useState<Record<string, { time: number; duration: number }>>({});
  const [cameraFocusPartBaselines, setCameraFocusPartBaselines] = useState<Record<string, string>>({});

  const subscribePlayback = useCallback(
    (listener: () => void) => playbackStore.subscribe(listener),
    [playbackStore],
  );
  const getPlaybackSnapshot = useCallback(() => playbackStore.playing, [playbackStore]);
  const isPlaying = useSyncExternalStore(subscribePlayback, getPlaybackSnapshot, () => false);

  const closeLesson = useCallback(() => {
    operationTokenRef.current += 1;
    if (completionTimerRef.current !== null) {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = null;
    }
    if (motionPreviewTimerRef.current !== null) {
      window.clearTimeout(motionPreviewTimerRef.current);
      motionPreviewTimerRef.current = null;
    }
    setPhase('idle');
    setExitConfirmationOpen(false);
  }, []);

  const requestLessonClose = useCallback(() => {
    setExitConfirmationOpen(true);
  }, []);

  useEffect(() => () => {
    if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current);
    if (motionPreviewTimerRef.current !== null) window.clearTimeout(motionPreviewTimerRef.current);
  }, []);

  useEffect(() => {
    if (phase !== 'guiding') return;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setDomRevision((current) => current + 1);
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'aria-label', 'aria-pressed', 'data-active'],
    });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [phase]);

  const modelReferences = useMemo(
    () => collectModelReferences(semanticDocument),
    [semanticDocument],
  );
  const modelReferenceFingerprint = modelReferences.join('\n');

  useEffect(() => {
    if (phase !== 'guiding') return;
    const token = ++operationTokenRef.current;
    if (modelReferences.length === 0) {
      setModelAvailability(EMPTY_MODEL_AVAILABILITY);
      setModelStatus('idle');
      return;
    }

    setModelStatus('checking');
    setModelAvailability(EMPTY_MODEL_AVAILABILITY);
    const validate = async () => {
      const nextAvailability: Record<string, boolean> = {};
      for (const reference of modelReferences) {
        try {
          const absolutePath = await projectResources.resolveForRead(reference);
          const result = await checkFirstLessonLive2DModelReadiness(
            absolutePath,
            fileAccess as WebGalAssetSourceFileAccess,
            { isRuntimeFamilyAvailable },
          );
          nextAvailability[reference] = result.status === 'found';
        } catch {
          nextAvailability[reference] = false;
        }
      }
      if (operationTokenRef.current !== token || phase !== 'guiding') return;
      setModelAvailability(nextAvailability);
      setModelStatus(Object.values(nextAvailability).some(Boolean) ? 'found' : 'needs_reselect');
    };
    void validate();
  }, [fileAccess, modelCheckRevision, modelReferenceFingerprint, modelReferences, phase, projectResources]);

  const assetSourceReady = assetStatus === 'found'
    || progress.completed
    || progress.currentStep !== 'prepare-asset-source';

  const visibleModelCharacterInputs = useMemo(
    () => ({ characterAdapter, runtimeRevision, semanticDocument }),
    [characterAdapter, runtimeRevision, semanticDocument],
  );
  const visibleModelCharacterIds = useMemo(() => (
    (visibleModelCharacterInputs.semanticDocument?.meta.characters ?? [])
      .filter((character) => visibleModelCharacterInputs.characterAdapter.hasCharacter(character.id))
      .map((character) => character.id)
  ), [visibleModelCharacterInputs]);
  const visibleModelCharacterFingerprint = visibleModelCharacterIds.join('\n');
  const visibleModelCharacterIdsRef = useRef<readonly string[]>(visibleModelCharacterIds);
  visibleModelCharacterIdsRef.current = visibleModelCharacterIds;

  /**
   * Records the first-observed time/duration of each dialogue statement. Later
   * stretch/drag edits are evaluated as a change relative to these baselines.
   */
  useEffect(() => {
    if (phase !== 'guiding') return;
    setDialogueBaselines((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const statement of semanticDocument?.statements ?? []) {
        if (statement.type !== 'dialogue') continue;
        if (!(statement.id in next)) {
          next[statement.id] = {
            time: statement.time,
            duration: statement.params.durationSeconds,
          };
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    setCameraFocusPartBaselines((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const statement of semanticDocument?.statements ?? []) {
        if (statement.type !== 'camera' || statement.params.mode !== 'focus') continue;
        if (!(statement.id in next)) {
          next[statement.id] = typeof statement.params.targetPart === 'string'
            ? statement.params.targetPart.trim()
            : '';
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [phase, semanticDocument]);

  useEffect(() => {
    if (phase !== 'guiding') return;
    const timer = window.setTimeout(() => {
      setConfirmedVisibleCharacterIds(visibleModelCharacterIdsRef.current);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [phase, visibleModelCharacterFingerprint]);

  const evaluation = useMemo(() => evaluateFirstLessonCompletion({
    assetSourceReady,
    document: semanticDocument,
    modelAvailabilityByReference: modelAvailability,
    runtime: {
      visibleModelCharacterIds: confirmedVisibleCharacterIds,
      hasPlayedCharacterEntrance,
      hasStartedPreview: progress.hasStartedPreview,
      hasPreviewedLive2DMotion,
      dialogueBaselines,
      cameraFocusPartBaselines,
    },
  }), [
    assetSourceReady,
    modelAvailability,
    progress.hasStartedPreview,
    semanticDocument,
    confirmedVisibleCharacterIds,
    hasPlayedCharacterEntrance,
    hasPreviewedLive2DMotion,
    dialogueBaselines,
    cameraFocusPartBaselines,
  ]);

  useEffect(() => {
    if (phase !== 'guiding' || evaluation.firstUnmetStep !== 'insert-character-entrance') return;
    const interval = window.setInterval(() => setRuntimeRevision((current) => current + 1), 300);
    return () => window.clearInterval(interval);
  }, [evaluation.firstUnmetStep, phase]);

  useEffect(() => {
    if (
      phase !== 'guiding'
      || evaluation.firstUnmetStep !== 'insert-character-entrance'
      || !isPlaying
      || hasPlayedCharacterEntrance
      || !hasEntranceStatement(semanticDocument, evaluation.selectedCharacterId)
    ) return;
    const timer = window.setTimeout(() => setHasPlayedCharacterEntrance(true), 2000);
    return () => window.clearTimeout(timer);
  }, [
    evaluation.firstUnmetStep,
    evaluation.selectedCharacterId,
    hasPlayedCharacterEntrance,
    isPlaying,
    phase,
    semanticDocument,
  ]);

  useEffect(() => {
    if (phase !== 'guiding' || !isPlaying || progress.hasStartedPreview) return;
    const timer = window.setTimeout(() => setProgress(progressStore.markPreviewStarted()), 1000);
    return () => window.clearTimeout(timer);
  }, [isPlaying, phase, progress.hasStartedPreview, progressStore]);

  useEffect(() => {
    if (phase !== 'guiding' || evaluation.completed) return;
    if (evaluation.firstUnmetStep && evaluation.firstUnmetStep !== progress.currentStep) {
      setProgress(progressStore.setCurrentStep(evaluation.firstUnmetStep));
    }
  }, [evaluation.completed, evaluation.firstUnmetStep, phase, progress.currentStep, progressStore]);

  useEffect(() => {
    if (phase !== 'guiding' || !evaluation.completed) return;
    setProgress(progressStore.markCompleted());
    setPhase('completed');
    completionTimerRef.current = window.setTimeout(() => {
      completionTimerRef.current = null;
      setPhase('idle');
    }, 8000);
  }, [evaluation.completed, phase, progressStore]);

  const enterGuide = useCallback(() => {
    setModelAvailability(EMPTY_MODEL_AVAILABILITY);
    setModelStatus('idle');
    setConfirmedVisibleCharacterIds([]);
    setHasPlayedCharacterEntrance(false);
    setMotionCtiPositioned(false);
    setMotionPlaybackRequested(false);
    setHasPreviewedLive2DMotion(false);
    setDialogueBaselines({});
    setCameraFocusPartBaselines({});
    setPhase('guiding');
  }, []);

  const openOrCreateTutorialProject = useCallback(async (token: number) => {
    setPhase('creating-project');
    const projectService = new FirstLessonProjectService(
      fileAccess,
      projectOpenWorkflow,
      progressStore,
    );
    try {
      const result = await projectService.createTutorialProject({
        defaultProjectDirectory,
      });
      if (operationTokenRef.current !== token) return;
      if (!result.success) {
        setErrorMessage('教程项目创建失败。请确认默认项目目录可写，然后重新开始教程。');
        setPhase('error');
        return;
      }
      setProgress(progressStore.load());
      enterGuide();
    } catch {
      if (operationTokenRef.current !== token) return;
      setErrorMessage('教程项目创建失败。请确认默认项目目录可写，然后重新开始教程。');
      setPhase('error');
    }
  }, [
    defaultProjectDirectory,
    enterGuide,
    fileAccess,
    progressStore,
    projectOpenWorkflow,
  ]);

  const scanAssetSources = useCallback(async () => {
    const token = ++operationTokenRef.current;
    const fingerprint = externalLibraryPaths.map(normalizePathForComparison).join('|');
    assetFingerprintRef.current = fingerprint;
    setAssetStatus('checking');
    setPhase('asset-checking');

    let found = false;
    for (const path of externalLibraryPaths) {
      try {
        const result = await checkWebGalAssetSourceReadiness(
          path,
          fileAccess as WebGalAssetSourceFileAccess,
          { isRuntimeFamilyAvailable },
        );
        if (result.status === 'found') {
          found = true;
          break;
        }
      } catch {
        // All readiness failures share the same author-facing state.
      }
    }

    if (operationTokenRef.current !== token) return;
    if (!found) {
      setAssetStatus('needs_reselect');
      setPhase('asset-setup');
      return;
    }

    setAssetStatus('found');
    setPhase('asset-found');
    await new Promise<void>((resolve) => window.setTimeout(resolve, 480));
    if (operationTokenRef.current !== token) return;
    await openOrCreateTutorialProject(token);
  }, [externalLibraryPaths, fileAccess, openOrCreateTutorialProject]);

  useEffect(() => {
    if (phase !== 'asset-setup') return;
    const fingerprint = externalLibraryPaths.map(normalizePathForComparison).join('|');
    if (!fingerprint || fingerprint === assetFingerprintRef.current) return;
    void scanAssetSources();
  }, [externalLibraryPaths, phase, scanAssetSources]);

  const startFirstLesson = useCallback(() => {
    operationTokenRef.current += 1;
    const next = progressStore.reset();
    setProgress(next);
    setIsWebGalAuthor(null);
    setAssetStatus('idle');
    setModelStatus('idle');
    setModelAvailability(EMPTY_MODEL_AVAILABILITY);
    setModelCheckRevision(0);
    setConfirmedVisibleCharacterIds([]);
    setHasPlayedCharacterEntrance(false);
    setMotionCtiPositioned(false);
    setMotionPlaybackRequested(false);
    setHasPreviewedLive2DMotion(false);
    setErrorMessage('');
    setPhase('intro');
  }, [progressStore]);

  const answerAuthorQuestion = useCallback((webGalAuthor: boolean) => {
    setIsWebGalAuthor(webGalAuthor);
    void scanAssetSources();
  }, [scanAssetSources]);

  const domSnapshotRefreshKey = useMemo(
    () => ({ domRevision, phase, semanticDocument }),
    [domRevision, phase, semanticDocument],
  );
  const domSnapshot = useMemo(
    () => readGuideDomSnapshot(domSnapshotRefreshKey),
    [domSnapshotRefreshKey],
  );

  const guideStep = phase === 'guiding' && evaluation.firstUnmetStep
    ? resolveFirstLessonGuideStep({
      ...domSnapshot,
      firstUnmetStep: evaluation.firstUnmetStep,
      modelStatus,
      hasEntranceStatement: hasEntranceStatement(semanticDocument, evaluation.selectedCharacterId),
      hasEnvironmentStatement: hasEnvironmentStatement(semanticDocument),
      hasDialogueStatement: hasDialogueStatement(semanticDocument),
      hasAnyMotionStatement: hasAnyMotionStatement(semanticDocument, evaluation.selectedCharacterId),
      hasCameraFocusStatement: hasCameraFocusStatement(semanticDocument),
      hasTunedCameraFocusPart: hasTunedCameraFocusPart(semanticDocument, cameraFocusPartBaselines),
      motionCtiPositioned,
    })
    : null;

  useEffect(() => {
    if (guideStep !== 'position-motion-cti') return;
    const ruler = document.querySelector<HTMLElement>('.timeline-ruler');
    if (!ruler) return;
    const handlePointerDown = () => {
      setMotionPlaybackRequested(false);
      setMotionCtiPositioned(true);
    };
    ruler.addEventListener('pointerdown', handlePointerDown, { once: true });
    return () => ruler.removeEventListener('pointerdown', handlePointerDown);
  }, [guideStep, domRevision]);

  useEffect(() => {
    if (guideStep !== 'play-motion' || motionPlaybackRequested) return;
    return registerMotionPlaybackListeners(() => setMotionPlaybackRequested(true));
  }, [guideStep, motionPlaybackRequested]);

  useEffect(() => {
    if (guideStep !== 'play-motion' || hasPreviewedLive2DMotion) {
      if (motionPreviewTimerRef.current !== null) {
        window.clearTimeout(motionPreviewTimerRef.current);
        motionPreviewTimerRef.current = null;
      }
      return;
    }
    if (!motionPlaybackRequested || motionPreviewTimerRef.current !== null) return;
    motionPreviewTimerRef.current = window.setTimeout(() => {
      motionPreviewTimerRef.current = null;
      setHasPreviewedLive2DMotion(true);
    }, 3000);
  }, [guideStep, hasPreviewedLive2DMotion, motionPlaybackRequested]);

  const guidePresentation = guideStep
    ? getGuidePresentation(guideStep, modelStatus)
    : null;

  const assetTargetSelector = externalLibraryPaths.length > 0
    ? `[data-tutorial-target="external-library-replace-${externalLibraryPaths.length - 1}"]`
    : '[data-tutorial-target="external-library-add"]';
  const assetDescription = externalLibraryPaths.length > 0
    ? '当前目录里没有找到可用模型。点击“修改”，重新选择直接包含 figure 文件夹的素材目录。'
    : isWebGalAuthor
      ? '点击“添加”，选择 WebGAL 中直接包含 figure 等素材子目录的目录，不要选择项目根目录。'
      : '点击“添加”，选择一个直接包含 figure 文件夹的素材目录。教程不会修改其中的文件。';

  return (
    <>
      {children({ startFirstLesson })}

      {!exitConfirmationOpen && phase === 'intro' && (
        <LessonDialog
          eyebrow="首次上手 · 约 7 分钟"
          title="你是 WebGAL 创作者吗？"
          description="这会决定素材目录的说明方式，不会读取或解析你的 WebGAL 项目。"
          onClose={requestLessonClose}
        >
          <div className="fl-lesson-dialog__choices">
            <button type="button" className="btn btn--primary" onClick={() => answerAuthorQuestion(true)}>
              是，我使用 WebGAL
            </button>
            <button type="button" className="btn" onClick={() => answerAuthorQuestion(false)}>
              不是
            </button>
          </div>
        </LessonDialog>
      )}

      {!exitConfirmationOpen && phase === 'asset-checking' && (
        <LessonDialog
          eyebrow={`第 1 / ${FIRST_LESSON_GUIDE_TOTAL_STEPS} 步 · 准备素材来源`}
          title="正在检查素材目录"
          description="只检查是否有完整、可显示的 Live2D 模型，不会生成模型清单或修改文件。"
          onClose={requestLessonClose}
          status={{ label: '正在检查', tone: 'checking' }}
        />
      )}

      {!exitConfirmationOpen && phase === 'asset-found' && (
        <LessonDialog
          eyebrow={`第 1 / ${FIRST_LESSON_GUIDE_TOTAL_STEPS} 步 · 准备素材来源`}
          title="已找到可用角色"
          description="素材已经准备好，接下来会打开一个新的“教程练习”项目。"
          onClose={requestLessonClose}
          icon="success"
          status={{ label: '已找到可用角色', tone: 'success' }}
        />
      )}

      {!exitConfirmationOpen && phase === 'asset-setup' && (
        <SpotlightOverlay
          targetSelector={assetTargetSelector}
          title={externalLibraryPaths.length > 0 ? '需要重新选择素材目录' : '设置素材目录'}
          description={assetDescription}
          stepLabel={`第 1 / ${FIRST_LESSON_GUIDE_TOTAL_STEPS} 步 · 准备素材来源`}
          onClose={requestLessonClose}
          status={externalLibraryPaths.length > 0
            ? { label: '需要重新选择', tone: 'warning' }
            : undefined}
          action={externalLibraryPaths.length > 0
            ? { label: '重新检查', onClick: () => void scanAssetSources() }
            : undefined}
          padding={7}
        />
      )}

      {!exitConfirmationOpen && phase === 'creating-project' && (
        <LessonDialog
          eyebrow="正在准备工作区"
          title="正在创建教程练习"
          description="将使用默认项目目录创建一个带时间后缀的新项目，不会覆盖旧项目。"
          onClose={requestLessonClose}
          status={{ label: '正在创建项目', tone: 'checking' }}
        />
      )}

      {!exitConfirmationOpen && phase === 'error' && (
        <LessonDialog
          eyebrow="教程暂时无法继续"
          title="没有准备好教程工作区"
          description={`${errorMessage} 关闭后可从项目主页重新点击“开始教程”。`}
          onClose={requestLessonClose}
          icon="info"
          status={{ label: '需要处理后重试', tone: 'warning' }}
        />
      )}

      {!exitConfirmationOpen && phase === 'guiding' && guidePresentation && (
        <SpotlightOverlay
          targetSelector={guidePresentation.selector}
          title={guidePresentation.title}
          description={guidePresentation.description}
          stepLabel={`第 ${guidePresentation.step} / ${FIRST_LESSON_GUIDE_TOTAL_STEPS} 步`}
          onClose={requestLessonClose}
          padding={guidePresentation.padding}
          allowTargetInteraction={guidePresentation.allowTargetInteraction}
          allowWorkspaceInteraction={guidePresentation.allowWorkspaceInteraction}
          showSpotlight={guidePresentation.showSpotlight}
          status={guidePresentation.status}
          action={guideStep === 'select-model' && modelStatus === 'needs_reselect'
            ? {
              label: '重新检查',
              onClick: () => setModelCheckRevision((current) => current + 1),
            }
            : undefined}
        />
      )}

      {!exitConfirmationOpen && phase === 'completed' && (
        <LessonDialog
          eyebrow="首课完成"
          title="你的第一个场景已经开始播放"
          description="角色已经登上舞台，环境画面、对白与 Live2D 动作也已写入场景；镜头对焦与对焦部位也都设置好了，语句的时长和位置可以随意调整。项目会保留在默认项目目录中。"
          onClose={closeLesson}
          icon="success"
          celebration
          status={{ label: '教程已完成', tone: 'success' }}
        />
      )}

      {exitConfirmationOpen && (
        <LessonDialog
          eyebrow="退出确认"
          title="要退出教程吗？"
          description="教程每次都会从头开始；下次点击“开始教程”会创建新的练习项目，重新走完整个流程。"
          onClose={() => setExitConfirmationOpen(false)}
          closeLabel="关闭退出确认"
          icon="info"
        >
          <div className="fl-lesson-dialog__choices">
            <button type="button" className="btn btn--primary" onClick={() => setExitConfirmationOpen(false)}>
              继续教程
            </button>
            <button type="button" className="btn" onClick={closeLesson}>
              退出教程
            </button>
          </div>
        </LessonDialog>
      )}
    </>
  );
};

export default FirstLessonController;
