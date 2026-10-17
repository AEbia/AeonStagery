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
import type { IPlaybackAdapter } from '../../api/interfaces/IPlaybackAdapter';
import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import { isLive2DRuntimeFamilyAvailable } from '../../engine/Live2DRuntimeResolver';
import { waitForLive2DRuntimeBootstrap } from '../../engine/Live2DRuntimeAvailability';
import {
  FIRST_LESSON_BUSINESS_STEPS,
  evaluateFirstLessonCompletion,
  FirstLessonProgressStore,
  FirstLessonProjectService,
  checkFirstLessonLive2DModelReadiness,
  checkWebGalAssetSourceReadiness,
  type FirstLessonBusinessStep,
  type FirstLessonProgressState,
  type WebGalAssetSourceReadinessFailureCode,
  type WebGalAssetSourceFileAccess,
} from '../../services/onboarding';
import type { IFileAccess } from '../../services/io/IFileAccess';
import { IconCheck, IconInfo, IconTarget, IconX } from '../icons';
import { useModalDialog } from '../hooks/useModalDialog';
import { settingsManager, useSettings } from '../SettingsStore';
import { findVisibleGuideTarget } from './guideTarget';
import { SpotlightOverlay } from './SpotlightOverlay';
import './firstLesson.css';

type LessonPhase =
  | 'idle'
  | 'intro'
  | 'asset-checking'
  | 'asset-found'
  | 'asset-setup'
  | 'creating-project'
  | 'choose-layout'
  | 'guiding'
  | 'completed'
  | 'error';

type ReadinessStatus = 'idle' | 'checking' | 'found' | 'needs_reselect';

const WEBGAL_SAMPLE_ASSET_ROOT = String.raw`...\public\games\<项目名>\game`;
const WEBGAL_SAMPLE_PROJECT_ROOT = String.raw`...\public\games\<项目名>`;
const WEBGAL_SAMPLE_FIGURE_ROOT = String.raw`...\public\games\<项目名>\game\figure`;

const ASSET_SOURCE_FAILURE_GUIDANCE: Record<WebGalAssetSourceReadinessFailureCode, string> = {
  'missing-figure-directory': '所选目录没有直接包含 figure/ 文件夹。请选 figure/ 的上一层 game/ 目录，不要选 figure/ 本身，也不要选上一级项目目录。',
  'no-loadable-model': 'figure/ 中没有找到可用的完整 Live2D 模型。请确认其中有受支持的模型入口文件及其依赖文件。',
  'model-entry-unreadable': '模型入口文件无法读取。请检查文件访问权限，或重新解压、复制完整的角色模型目录后重试。',
  'model-entry-invalid-json': '模型入口文件不是有效的 JSON。请从模型原始素材重新导出或复制该文件。',
  'model-format-unrecognized': '没有识别到受支持的 Cubism 模型入口。请选择 model.json、*.model.json 或 *.model3.json。',
  'model-runtime-unavailable': '当前没有可用的模型运行时。请改选当前支持的 Cubism 模型，或先启用对应运行时。',
  'model-body-missing': '模型引用的主体文件缺失。请重新复制完整的角色模型目录，并保留文件夹结构。',
  'model-texture-missing': '模型引用的纹理图片不完整。请重新复制完整的角色模型目录，并保留纹理路径。',
};

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
  | 'open-motion-panel'
  | 'switch-to-motion-actions'
  | 'open-camera-panel'
  | 'switch-to-camera-actions'
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
  | 'position-preview-cti'
  | 'start-preview';

interface GuideDomSnapshot {
  actionPanelHidden?: boolean;
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
  previewCtiPositioned: boolean;
}

const FIRST_LESSON_GUIDE_TOTAL_STEPS = 13;

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
  playbackAdapter: Pick<IPlaybackAdapter, 'getCurrentTime' | 'subscribeTime'>;
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

const isVisible = (selector: string) => findVisibleGuideTarget(selector) !== null;

const readGuideDomSnapshot = (_refreshKey: {
  readonly domRevision: number;
  readonly phase: LessonPhase;
  readonly semanticDocument: CurrentSceneDocument | null;
}): GuideDomSnapshot => ({
  actionPanelHidden: isVisible('.property-inspector-shell [aria-label="返回属性检查器"]')
    || isVisible('.side-panel .context-panel'),
  characterDirectoryVisible: isVisible('[data-testid="character-directory"]'),
  inspectorPickerOpen: findVisibleGuideTarget('.inspector-view-picker')?.hasAttribute('open') ?? false,
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
  environmentImageFieldVisible: isVisible('[data-resource-directory="background"] button'),
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
    if (input.actionPanelHidden) {
      return input.inspectorPickerOpen ? 'switch-to-motion-actions' : 'open-motion-panel';
    }
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
    if (input.cameraBlockVisible && input.cameraBlockSelected && input.actionPanelHidden) {
      return input.inspectorPickerOpen ? 'switch-to-camera-actions' : 'open-camera-panel';
    }
    return input.cameraBlockVisible && input.cameraBlockSelected
      ? 'choose-camera-focus-part'
      : 'select-camera-focus';
  }

  return input.previewCtiPositioned ? 'start-preview' : 'position-preview-cti';
}

export const getGuidePresentation = (
  step: FirstLessonGuideStep,
  modelStatus: ReadinessStatus,
  layoutMode: 'tracks' | 'list' = 'list',
): GuidePresentation => {
  const isTracksMode = layoutMode === 'tracks';
  switch (step) {
    case 'open-character-panel':
      return {
        selector: isTracksMode ? '#left-panel-tab-characters' : '.inspector-view-picker',
        title: '进入角色管理',
        description: isTracksMode
          ? '点击左侧的“角色管理”选项卡，准备登上舞台的角色。'
          : '点击右侧的视图切换器，接下来进入角色管理。',
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
        description: '正在确认模型本体、纹理和 Cubism 运行时。检查完成后会自动继续。',
        step: 3,
        allowTargetInteraction: false,
        status: { label: '正在检查', tone: 'checking' },
      };
    case 'select-model':
      return {
        selector: '[aria-label="选择模型文件"]',
        title: modelStatus === 'needs_reselect' ? '需要重新选择模型' : '为角色选择模型',
        description: modelStatus === 'needs_reselect'
          ? '请选择文件齐全且运行时可用的 Cubism 2.1 或 Cubism 3/4/5（C3+）模型入口'
          : '点击文件夹按钮，为角色选择一个可用的模型。',
        step: 3,
        status: modelStatus === 'needs_reselect'
          ? { label: '需要重新选择', tone: 'warning' }
          : undefined,
      };
    case 'pick-model-file':
      return {
        selector: '[role="dialog"][aria-labelledby="asset-browser-title"]',
        title: '选择模型入口文件',
        description: '在 figure 中找到角色模型，选择 *.model.json 或 *.model3.json',
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
        selector: isTracksMode
          ? '.property-inspector-shell [aria-label="返回属性检查器"]'
          : '.inspector-view-picker > summary',
        title: '打开环境编辑视图',
        description: isTracksMode
          ? '环境语句已经选中。点击“返回属性检查器”，为它选择背景图片。'
          : '环境语句已经选中。点击侧栏视图切换器，回到“剧本动作”。',
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
        selector: '[data-resource-directory="background"] button',
        title: '选择一张背景图片',
        description: '点击背景资源选择按钮，打开资源浏览器，为环境选择一张背景图片。',
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
    case 'open-motion-panel':
    case 'open-camera-panel':
      return {
        selector: isTracksMode
          ? '.property-inspector-shell [aria-label="返回属性检查器"]'
          : '.inspector-view-picker > summary',
        title: step === 'open-action-panel' ? '打开对白编辑视图' : '打开语句属性',
        description: isTracksMode
          ? '语句已经选中。点击“返回属性检查器”，继续编辑它的属性。'
          : '语句已经选中。点击侧栏视图切换器，回到“剧本动作”。',
        step: step === 'open-motion-panel' ? 9 : step === 'open-camera-panel' ? 12 : 6,
      };
    case 'switch-to-actions':
    case 'switch-to-motion-actions':
    case 'switch-to-camera-actions':
      return {
        selector: '.inspector-view-picker__menu [role="menuitemradio"][aria-label^="剧本动作"]',
        title: '进入剧本动作',
        description: '选择“剧本动作”，在右侧编辑选中语句的属性。',
        step: step === 'switch-to-motion-actions' ? 9 : step === 'switch-to-camera-actions' ? 12 : 6,
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
        description: '选择一个非 idle 动作，作为角色在这一刻的表演。可以切换左侧分组或搜索动作名称。',
        step: 9,
        padding: 3,
        allowWorkspaceInteraction: true,
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
    case 'position-preview-cti':
      return {
        selector: '.timeline-ruler',
        title: '把 CTI 移到镜头对焦之前',
        description: '在时间标尺上点击镜头对焦语句之前的位置，让播放从对焦前开始。如果对焦位于 0 秒，就把 CTI 移到 0 秒。',
        step: 12,
        padding: 2,
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

const isRuntimeFamilyAvailable = async (runtimeFamily: 'cubism2' | 'cubism3-plus') => {
  await waitForLive2DRuntimeBootstrap();
  return isLive2DRuntimeFamilyAvailable(runtimeFamily);
};

const LessonDialog: React.FC<{
  eyebrow: string;
  title: string;
  description: string;
  onClose: () => void;
  closeLabel?: string;
  icon?: 'target' | 'success' | 'info';
  celebration?: boolean;
  previewWorkspace?: boolean;
  status?: { label: string; tone: 'checking' | 'success' | 'warning' };
  children?: React.ReactNode;
}> = ({ eyebrow, title, description, onClose, closeLabel = '关闭教程', icon = 'target', celebration = false, previewWorkspace = false, status, children }) => {
  const dialogRef = useModalDialog(onClose);
  const Icon = icon === 'success' ? IconCheck : icon === 'info' ? IconInfo : IconTarget;

  return createPortal(
    <div className={`fl-lesson-modal-layer${previewWorkspace ? ' fl-lesson-modal-layer--layout' : ''}`}>
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

// Native radios update the choice while settings redraw the workspace preview.
// Keep this dialog outside that subscription so its content and focus stay stable.
const LayoutSelectionDialog = React.memo<{
  onClose: () => void;
  onContinue: () => void;
}>(({ onClose, onContinue }) => {
  const [initialLayout] = useState(() => settingsManager.get('workbenchTimelineLayoutMode'));
  return (
    <LessonDialog
      eyebrow={`第 2 / ${FIRST_LESSON_GUIDE_TOTAL_STEPS} 步 · 选择工作台布局`}
      title="选择你喜欢的工作台布局"
      description="两种布局都能完成本课。选择会立即保存，以后也可以在“全局设置 → 基础体验 → 工作区布局”中切换。"
      onClose={onClose}
      previewWorkspace
    >
      <fieldset className="fl-layout-choices" aria-label="工作台布局模式">
        {([
          { value: 'tracks', label: '轨道编辑优先', description: '底部轨道占满宽度，左侧管理角色与剧本大纲，右侧编辑选中语句的属性。' },
          { value: 'list', label: '剧本动作优先', description: '右侧剧本动作列表占满高度，展开语句即可编辑属性，适合逐句编排故事。' },
        ] as const).map((layout) => (
          <label key={layout.value} className="fl-layout-choice">
            <input
              type="radio"
              name="first-lesson-layout"
              value={layout.value}
              defaultChecked={initialLayout === layout.value}
              onChange={() => settingsManager.set('workbenchTimelineLayoutMode', layout.value)}
            />
            <span><strong>{layout.label}</strong><span>{layout.description}</span></span>
          </label>
        ))}
      </fieldset>
      <button type="button" className="btn btn--primary" onClick={onContinue}>
        使用此布局，继续教程
      </button>
    </LessonDialog>
  );
});

export const FirstLessonController: React.FC<FirstLessonControllerProps> = ({
  semanticDocument,
  externalLibraryPaths,
  defaultProjectDirectory,
  fileAccess,
  projectOpenWorkflow,
  projectResources,
  characterAdapter,
  playbackStore,
  playbackAdapter,
  children,
}) => {
  const { settings } = useSettings();
  const progressStore = useMemo(
    () => new FirstLessonProgressStore(createSafeBrowserStorage()),
    [],
  );
  const [progress, setProgress] = useState<FirstLessonProgressState>(() => progressStore.load());
  const [phase, setPhase] = useState<LessonPhase>('idle');
  const [isWebGalAuthor, setIsWebGalAuthor] = useState<boolean | null>(null);
  const [assetStatus, setAssetStatus] = useState<ReadinessStatus>('idle');
  const [assetFailureCode, setAssetFailureCode] = useState<WebGalAssetSourceReadinessFailureCode | null>(null);
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
  const [previewCtiPositioned, setPreviewCtiPositioned] = useState(false);
  const [previewPlaybackStarted, setPreviewPlaybackStarted] = useState(false);
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
      attributeFilter: ['open', 'hidden', 'aria-label', 'aria-pressed', 'aria-selected', 'data-active', 'data-timeline-layout'],
    });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [phase]);

  const modelReferenceFingerprint = useMemo(
    () => collectModelReferences(semanticDocument).join('\n'),
    [semanticDocument],
  );
  const modelReferences = useMemo(
    () => modelReferenceFingerprint ? modelReferenceFingerprint.split('\n') : [],
    [modelReferenceFingerprint],
  );

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

  // The persisted current step marks every earlier tutorial step as completed.
  // Keep that progress when later runtime or document snapshots invalidate an earlier condition.
  const progressEvaluation = useMemo(() => {
    const currentStepIndex = FIRST_LESSON_BUSINESS_STEPS.indexOf(progress.currentStep);
    const firstUnmetStep = FIRST_LESSON_BUSINESS_STEPS
      .slice(currentStepIndex)
      .find((step) => !evaluation.satisfiedSteps.includes(step)) ?? null;
    return {
      ...evaluation,
      completed: firstUnmetStep === null,
      firstUnmetStep,
    };
  }, [evaluation, progress.currentStep]);

  const cameraFocusTime = useMemo(() => {
    const times = (semanticDocument?.statements ?? [])
      .filter((statement) => statement.type === 'camera' && statement.params.mode === 'focus')
      .map((statement) => statement.time);
    return times.length > 0 ? Math.min(...times) : null;
  }, [semanticDocument]);
  const isBeforeCameraFocus = useCallback((time: number) => (
    cameraFocusTime !== null && Number.isFinite(time) && time >= 0
    && (time < cameraFocusTime || (cameraFocusTime === 0 && time === 0))
  ), [cameraFocusTime]);

  useEffect(() => {
    setPreviewPlaybackStarted(false);
    if (phase !== 'guiding' || progressEvaluation.firstUnmetStep !== 'start-preview') {
      setPreviewCtiPositioned(false);
      return;
    }
    setPreviewCtiPositioned(isBeforeCameraFocus(playbackAdapter.getCurrentTime()));
    const unsubscribeTime = playbackAdapter.subscribeTime((time) => {
      setPreviewCtiPositioned(isBeforeCameraFocus(time));
    });
    let wasPlaying = playbackStore.playing;
    const unsubscribePlayback = playbackStore.subscribe(() => {
      const playing = playbackStore.playing;
      if (playing && !wasPlaying) {
        // Capture the starting CTI before playback advances past the focus.
        setPreviewPlaybackStarted(isBeforeCameraFocus(playbackAdapter.getCurrentTime()));
      } else if (!playing) {
        setPreviewPlaybackStarted(false);
      }
      wasPlaying = playing;
    });
    return () => {
      unsubscribeTime();
      unsubscribePlayback();
    };
  }, [isBeforeCameraFocus, phase, playbackAdapter, playbackStore, progressEvaluation.firstUnmetStep]);

  useEffect(() => {
    if (phase !== 'guiding' || progressEvaluation.firstUnmetStep !== 'insert-character-entrance') return;
    const interval = window.setInterval(() => setRuntimeRevision((current) => current + 1), 300);
    return () => window.clearInterval(interval);
  }, [progressEvaluation.firstUnmetStep, phase]);

  useEffect(() => {
    if (
      phase !== 'guiding'
      || progressEvaluation.firstUnmetStep !== 'insert-character-entrance'
      || !isPlaying
      || hasPlayedCharacterEntrance
      || !hasEntranceStatement(semanticDocument, evaluation.selectedCharacterId)
    ) return;
    // Playback can stop before the model finishes loading. Remember that it ran;
    // completion still waits for the character's confirmed presence on stage.
    setHasPlayedCharacterEntrance(true);
  }, [
    progressEvaluation.firstUnmetStep,
    evaluation.selectedCharacterId,
    hasPlayedCharacterEntrance,
    isPlaying,
    phase,
    semanticDocument,
  ]);

  useEffect(() => {
    if (
      phase !== 'guiding'
      || progressEvaluation.firstUnmetStep !== 'start-preview'
      || !isPlaying
      || !previewPlaybackStarted
      || progress.hasStartedPreview
    ) return;
    const timer = window.setTimeout(() => setProgress(progressStore.markPreviewStarted()), 1000);
    return () => window.clearTimeout(timer);
  }, [isPlaying, phase, previewPlaybackStarted, progress.hasStartedPreview, progressEvaluation.firstUnmetStep, progressStore]);

  useEffect(() => {
    if (phase !== 'guiding' || progressEvaluation.completed) return;
    if (progressEvaluation.firstUnmetStep && progressEvaluation.firstUnmetStep !== progress.currentStep) {
      setProgress(progressStore.setCurrentStep(progressEvaluation.firstUnmetStep));
    }
  }, [phase, progress.currentStep, progressEvaluation.completed, progressEvaluation.firstUnmetStep, progressStore]);

  useEffect(() => {
    if (phase !== 'guiding' || !progressEvaluation.completed) return;
    setProgress(progressStore.markCompleted());
    setPhase('completed');
    completionTimerRef.current = window.setTimeout(() => {
      completionTimerRef.current = null;
      setPhase('idle');
    }, 8000);
  }, [phase, progressEvaluation.completed, progressStore]);

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
      setPhase('choose-layout');
    } catch {
      if (operationTokenRef.current !== token) return;
      setErrorMessage('教程项目创建失败。请确认默认项目目录可写，然后重新开始教程。');
      setPhase('error');
    }
  }, [
    defaultProjectDirectory,
    fileAccess,
    progressStore,
    projectOpenWorkflow,
  ]);

  const scanAssetSources = useCallback(async () => {
    const token = ++operationTokenRef.current;
    const fingerprint = externalLibraryPaths.map(normalizePathForComparison).join('|');
    assetFingerprintRef.current = fingerprint;
    setAssetStatus('checking');
    setAssetFailureCode(null);
    setPhase('asset-checking');

    let found = false;
    let failureCode: WebGalAssetSourceReadinessFailureCode | null = null;
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
        if (result.status === 'needs_reselect') failureCode = result.code;
      } catch {
        failureCode = 'no-loadable-model';
      }
    }

    if (operationTokenRef.current !== token) return;
    if (!found) {
      setAssetFailureCode(externalLibraryPaths.length > 0 ? failureCode ?? 'no-loadable-model' : null);
      setAssetStatus('needs_reselect');
      setPhase('asset-setup');
      return;
    }

    setAssetFailureCode(null);
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
    setAssetFailureCode(null);
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
    () => ({ domRevision, phase, semanticDocument, layoutMode: settings.workbenchTimelineLayoutMode }),
    [domRevision, phase, semanticDocument, settings.workbenchTimelineLayoutMode],
  );
  const domSnapshot = useMemo(
    () => readGuideDomSnapshot(domSnapshotRefreshKey),
    [domSnapshotRefreshKey],
  );

  const guideStep = phase === 'guiding' && progressEvaluation.firstUnmetStep
    ? resolveFirstLessonGuideStep({
      ...domSnapshot,
      firstUnmetStep: progressEvaluation.firstUnmetStep,
      modelStatus,
      hasEntranceStatement: hasEntranceStatement(semanticDocument, evaluation.selectedCharacterId),
      hasEnvironmentStatement: hasEnvironmentStatement(semanticDocument),
      hasDialogueStatement: hasDialogueStatement(semanticDocument),
      hasAnyMotionStatement: hasAnyMotionStatement(semanticDocument, evaluation.selectedCharacterId),
      hasCameraFocusStatement: hasCameraFocusStatement(semanticDocument),
      hasTunedCameraFocusPart: hasTunedCameraFocusPart(semanticDocument, cameraFocusPartBaselines),
      motionCtiPositioned,
      previewCtiPositioned: previewCtiPositioned || (isPlaying && previewPlaybackStarted),
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
    ? getGuidePresentation(guideStep, modelStatus, settings.workbenchTimelineLayoutMode)
    : null;

  // Keep the menu's categories and search reachable even when a filter hides the desired card.
  const insertionMenuStep = guideStep === 'insert-entrance'
    || guideStep === 'insert-environment'
    || guideStep === 'insert-dialogue'
    || guideStep === 'insert-motion'
    || guideStep === 'insert-camera-focus';
  const guideTargetSelector = guidePresentation && insertionMenuStep && !isVisible(guidePresentation.selector)
    ? '[data-testid="timeline-blank-insert-menu"]'
    : guidePresentation?.selector;

  const assetTargetSelector = externalLibraryPaths.length > 0
    ? `[data-tutorial-target="external-library-replace-${externalLibraryPaths.length - 1}"]`
    : '[data-tutorial-target="external-library-add"]';
  const assetDescription = assetFailureCode
    ? `${ASSET_SOURCE_FAILURE_GUIDANCE[assetFailureCode]} 点击“如何准备素材”查看目录示例。`
    : `${isWebGalAuthor ? '选择 WebGAL 游戏素材目录' : '选择素材目录'}，要求这一层直接包含 figure/ 文件夹。点击“如何准备素材”查看路径示例。`;
  const assetHelpContent = (
    <>
      <p>选择 figure/ 的上一层 game/ 目录。figure/ 是 WebGAL 游戏目录中存放角色立绘和 Live2D 模型的素材目录。</p>
      <div className="fl-spotlight__help-examples">
        <div>
          <strong>正确层级</strong>
          <code>{WEBGAL_SAMPLE_ASSET_ROOT}</code>
          <span>所选目录直接包含 figure/ 和 background/ 等素材目录。</span>
        </div>
        <div>
          <strong>选得太浅</strong>
          <code>{WEBGAL_SAMPLE_PROJECT_ROOT}</code>
          <span>这是项目目录，figure/ 在其下方的 game/ 里面。</span>
        </div>
        <div>
          <strong>选得太深</strong>
          <code>{WEBGAL_SAMPLE_FIGURE_ROOT}</code>
          <span>这是 figure/ 本身，应选择它的上一层 game/。</span>
        </div>
      </div>
      <p>把“项目名”换成你的项目目录名。本课会检查 figure/ 中的模型和依赖文件，不会修改素材。</p>
    </>
  );

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
          description="检查 Cubism 2.1 与 Cubism 3/4/5（C3+）模型的本体、纹理和对应运行时"
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
          help={{ label: '如何准备素材', content: assetHelpContent }}
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

      {!exitConfirmationOpen && phase === 'choose-layout' && (
        <LayoutSelectionDialog onClose={requestLessonClose} onContinue={enterGuide} />
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

      {!exitConfirmationOpen && phase === 'guiding' && guidePresentation && guideTargetSelector && (
        <SpotlightOverlay
          targetSelector={guideTargetSelector}
          fallbackTargetSelector={insertionMenuStep ? '[data-testid="timeline-blank-insert-menu"]' : undefined}
          title={guidePresentation.title}
          description={guidePresentation.description}
          stepLabel={`第 ${guidePresentation.step + 1} / ${FIRST_LESSON_GUIDE_TOTAL_STEPS} 步`}
          onClose={requestLessonClose}
          padding={guidePresentation.padding}
          allowTargetInteraction={guidePresentation.allowTargetInteraction}
          allowWorkspaceInteraction={insertionMenuStep || guidePresentation.allowWorkspaceInteraction}
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
