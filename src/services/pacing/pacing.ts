import type { AiRhythmPace } from '../../api/types/ai-authoring';

/**
 * 共享本地演出节奏模块:语句级时长基准与节奏档位。
 * 纯本地规则计算,不依赖任何外部 API / 网络 / 用户密钥。
 */

/** 节奏档位间隔:一句对白结束后到下一句开始前的空档(秒)。 */
export const PACE_GAP: Record<AiRhythmPace, number> = {
  snap: 0.25,
  normal: 0.5,
  slow: 0.8,
  hold: 1.2,
};

/** 节奏档位倍数:对节奏档位基准时长的缩放系数,正常档为恒等。 */
export const PACE_MULTIPLIER: Record<AiRhythmPace, number> = {
  snap: 0.82,
  normal: 1,
  slow: 1.25,
  hold: 1.5,
};

/** 节奏档位停顿:纯停顿步骤的时长(秒)。 */
export const PACE_PAUSE_DURATION: Record<AiRhythmPace, number> = {
  snap: 0.4,
  normal: 0.8,
  slow: 1.3,
  hold: 2.0,
};

/** 对白时长估算基准:按字符数估算时的默认参数(秒)。 */
export interface DialogueDurationOptions {
  /** 每字符估算秒数。 */
  perCharSeconds: number;
  /** 每句固定的基准秒数。 */
  baseSeconds: number;
  /** 单句估算下限(秒)。 */
  minSeconds: number;
  /** 单句估算上限(秒)。 */
  maxSeconds: number;
  /** 阅读速度倍数;>1 读得更快(估算更短)。 */
  speed: number;
}

/** 用户可配置的手工对白默认时长范围。 */
export const DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE = {
  min: 0.5,
  max: 20,
  step: 0.5,
} as const;

/** 未提供设置覆盖时，新建手工对白使用的默认时长。 */
export const DEFAULT_DIALOGUE_DURATION_SECONDS = 2;

export const DEFAULT_DIALOGUE_DURATION_OPTIONS: DialogueDurationOptions = {
  perCharSeconds: 0.25,
  baseSeconds: 1,
  minSeconds: 1.5,
  maxSeconds: 12,
  speed: 1.5,
};

/** WebGAL 默认转场时长(秒;WebGAL 内部以毫秒计)。 */
export const TRANSITION_DURATIONS = {
  backgroundChange: 1.0,
  figureEnter: 0.3,
  figureExit: 0.45,
  cameraFocus: 0.5,
  setTransform: 0.5,
} as const;

const COMPACT_LENGTH_DIVISOR = 7;
const BASE_SECONDS_BY_LENGTH = 0.8;
const MIN_BASE_SECONDS = 1.6;
const MAX_BASE_SECONDS = 7;
const MIN_TOTAL_SECONDS = 1.4;
const MAX_TOTAL_SECONDS = 9;

export interface DialogueTypewriterTiming {
  /** Seconds per visible character, read from the current local setting. */
  textSpeed: number;
  entranceAnimation: boolean;
}

export type DialogueDurationPolicyRequest =
  | {
    /** 时间线 UI 新建草稿或字段默认值。 */
    context: 'manual-default';
    defaultDurationSeconds?: number;
  }
  | {
    /** New editor dialogue: retain its default hold while allowing the text to finish. */
    context: 'authoring-insert';
    text: string;
    authoredDurationSeconds: number;
    typewriter?: DialogueTypewriterTiming;
  }
  | {
    /** AI / 顺序铺戏 / authoring 插入按场景节奏档位估算。 */
    context: 'pace-tier';
    text: string;
    pace: AiRhythmPace;
    typewriter?: DialogueTypewriterTiming;
  }
  | {
    /** WebGAL 导入按阅读速度估算。 */
    context: 'reading-speed';
    text: string;
    options?: Partial<DialogueDurationOptions>;
  }
  | {
    /** 文本编辑时：手工时间/时长修改保留 authored duration，否则重算。 */
    context: 'authoring-update';
    text: string;
    pace: AiRhythmPace;
    authoredDurationSeconds: number;
    timeWasEdited: boolean;
    durationWasEdited: boolean;
    typewriter?: DialogueTypewriterTiming;
  };

/**
 * 对白时长 policy 的唯一入口。
 *
 * 调用方只声明创作语境；估算模型、设置回退和“文本更新是否重算”的
 * 选择留在该模块内。不同语境可以有意返回不同答案，不要求所有路径
 * 共享同一套估算公式。
 */
export function resolveDialogueDuration(request: DialogueDurationPolicyRequest): number {
  switch (request.context) {
    case 'manual-default':
      return normalizeManualDialogueDuration(
        request.defaultDurationSeconds,
        DEFAULT_DIALOGUE_DURATION_SECONDS,
      );
    case 'authoring-insert':
      return allowTypewriterDuration(request.authoredDurationSeconds, request.text, request.typewriter);
    case 'pace-tier':
      return allowTypewriterDuration(estimateDialogueDuration(request.text, request.pace), request.text, request.typewriter);
    case 'reading-speed':
      return estimateDialogueDurationByReadingSpeed(request.text, request.options);
    case 'authoring-update':
      return request.timeWasEdited || request.durationWasEdited
        ? request.authoredDurationSeconds
        : allowTypewriterDuration(estimateDialogueDuration(request.text, request.pace), request.text, request.typewriter);
  }
}

function allowTypewriterDuration(duration: number, text: string, timing?: DialogueTypewriterTiming): number {
  if (!timing || !Number.isFinite(timing.textSpeed) || timing.textSpeed <= 0) return duration;
  const characters = [...text.replace(/[\r\n\u200B]/g, '')].length;
  const revealSeconds = characters * timing.textSpeed + (timing.entranceAnimation ? 0.2 : 0);
  // Round upward so authoring's 0.1-second precision cannot cut off the last character.
  return Math.max(duration, Math.ceil(revealSeconds * 10 - 1e-9) / 10);
}

/** 规范化设置覆盖；非法值回退到 policy 的默认值。 */
export function normalizeManualDialogueDuration(
  value: unknown,
  fallback = DEFAULT_DIALOGUE_DURATION_SECONDS,
): number {
  const safeFallback = Number.isFinite(fallback)
    ? clamp(fallback, DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE.min, DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE.max)
    : DEFAULT_DIALOGUE_DURATION_SECONDS;
  if (typeof value !== 'number' || !Number.isFinite(value)) return safeFallback;
  return clamp(
    value,
    DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE.min,
    DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE.max,
  );
}

function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 按紧凑字符长度与节奏档位估算一句对白的时长(秒,精确到 0.1)。 */
export function estimateDialogueDuration(text: string, pace: AiRhythmPace): number {
  const compactLength = text.replace(/\s+/g, '').length;
  const base = clamp((compactLength / COMPACT_LENGTH_DIVISOR) + BASE_SECONDS_BY_LENGTH,
    MIN_BASE_SECONDS, MAX_BASE_SECONDS);
  return roundTime(clamp(base * PACE_MULTIPLIER[pace], MIN_TOTAL_SECONDS, MAX_TOTAL_SECONDS));
}

/** 按每字符阅读速度估算一句对白的时长(秒);非法 speed 覆盖回退默认值。 */
export function estimateDialogueDurationByReadingSpeed(
  text: string,
  options: Partial<DialogueDurationOptions> = {},
): number {
  const duration = { ...DEFAULT_DIALOGUE_DURATION_OPTIONS, ...options };
  const charCount = [...text].length;
  const speed = Number.isFinite(duration.speed) && duration.speed > 0
    ? duration.speed
    : DEFAULT_DIALOGUE_DURATION_OPTIONS.speed;
  const rate = duration.perCharSeconds / speed;
  const estimated = duration.baseSeconds + charCount * rate;
  return Math.min(duration.maxSeconds, Math.max(duration.minSeconds, estimated));
}
