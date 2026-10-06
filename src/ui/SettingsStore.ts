import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import type { GptSovitsLocalConfig } from '../services/voice/GptSovitsTypes';
import type { ExternalLibraryMount, ProjectExternalLibraryBindings } from '../api/types/project';
import { normalizeMountId } from '../api/types/project';
export { projectExternalLibraryBindingsSignature } from '../api/types/project';
import { normalizeExperimentalFeatureReadState } from '../services/beta/ExperimentalFeatures';
import type { ExperimentalFeatureReadState } from '../services/beta/ExperimentalFeatures';
import { DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS } from './shortcuts/defaults';
import type { KeyboardShortcutsSettings } from './shortcuts/types';
import { normalizeKeyboardShortcutsSettings } from './shortcuts/shortcutUtils';
import {
  AI_PROSE_STAGES,
  AI_PROSE_EFFORTS,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_EFFORT,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_TARGET_BATCH_SIZE,
  DEFAULT_MAX_CONCURRENT_AI_REQUESTS,
  DEFAULT_SCRIPT_READING_SPEED,
  SCRIPT_READING_SPEED_RANGE,
  type AiProseStage,
  type AiProseEffort,
} from '../api/types/ai-prose-authoring';
import { getAiProseProviderIdentity } from '../services/ai-authoring/AiProseGlobalConfiguration';
import {
  DEFAULT_DIALOGUE_DURATION_SECONDS,
  normalizeManualDialogueDuration,
} from '../services/pacing/pacing';

export { DEFAULT_DIALOGUE_DURATION_SECONDS_RANGE } from '../services/pacing/pacing';

export interface RecentProjectEntry {
  name: string;
  projectFilePath: string;
  rootPath: string;
  lastOpenedAt: string;
}

export const MAX_RECENT_PROJECTS = 6;
export type AppTheme = 'light' | 'dark' | 'system';

function normalizeTheme(value: unknown): AppTheme {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export interface AppSettings {
  lowPerformance: boolean;
  autoSave: boolean;
  theme: AppTheme;

  assetsPath: string;
  externalLibraryMounts: ExternalLibraryMount[];
  /** Machine-local external-library roots per project: projectId → mountId → absolute path. */
  projectExternalLibraryBindings: ProjectExternalLibraryBindings;
  hasCompletedExternalLibraryOnboarding: boolean;
  experimentalFeatureReadState: ExperimentalFeatureReadState;
  recentProjects: RecentProjectEntry[];
  lastReadChangelogId?: string;
  readAnnouncementIds?: string[];
  autoShowChangelogOnUpdate?: boolean;
  showLive2DRuntimeSetupOnStartup: boolean;
  preBakeEnabled: boolean;
  bakePrecision: number;
  preBakeHotRadius: number;
  preBakeWarmRadius: number;
  preBakeHotPrecision: number;
  preBakeWarmPrecision: number;
  preBakeColdPrecision: number;
  preBakeDebounce: number;
  snapshotMaxCount: number;
  typewriterSpeed: number;
  dialogueTextSpeed: number;
  dialogueFontSize: number;
  dialogueEntranceAnimation: boolean;
  defaultDialogueDurationSeconds: number;
  scriptReadingSpeed: number;
  aiProse: {
    baseUrl: string;
    defaultModel: string;
    modelOverrides?: Partial<Record<AiProseStage, string>>;
    /** Optional project-agent model; unset inherits defaultModel. */
    projectAgentModel?: string;
    jsonOutputSupported: boolean;
    capabilityIdentity?: string;
    targetBatchSize: number;
    maxConcurrentAiRequests: number;
    effort: AiProseEffort;
  };

  masterVolume: number;
  voiceVolume: number;
  bgmVolume: number;
  gptSovits: GptSovitsLocalConfig;

  dialogueSignatureText1: string;
  dialogueSignatureColor1: string;
  dialogueSignatureText2: string;
  dialogueSignatureColor2: string;

  workbenchPanelWidth: number;
  workbenchDetailWidth: number;
  workbenchContextWidth: number;
  workbenchTimelineHeight: number;
  workbenchTimelineLayoutMode: 'tracks' | 'list';
  workbenchDialogueFlowMode: 'auto' | 'manual';
  workbenchContextPanelOpen: boolean;
  workbenchContextTab: 'characters' | 'snapshot' | 'script' | 'diagnostics';
  keyboardShortcuts: KeyboardShortcutsSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  lowPerformance: false,
  autoSave: true,
  theme: 'system',
  assetsPath: '',
  externalLibraryMounts: [],
  projectExternalLibraryBindings: {},
  hasCompletedExternalLibraryOnboarding: false,
  experimentalFeatureReadState: {},
  recentProjects: [],
  lastReadChangelogId: undefined,
  readAnnouncementIds: [],
  autoShowChangelogOnUpdate: true,
  showLive2DRuntimeSetupOnStartup: true,
  preBakeEnabled: true,
  bakePrecision: 0.1,
  preBakeHotRadius: 5,
  preBakeWarmRadius: 30,
  preBakeHotPrecision: 0.1,
  preBakeWarmPrecision: 0.5,
  preBakeColdPrecision: 2.0,
  preBakeDebounce: 500,
  snapshotMaxCount: 5000,
  typewriterSpeed: 0.025,
  dialogueTextSpeed: 0.025,
  dialogueFontSize: 48,
  dialogueEntranceAnimation: true,
  defaultDialogueDurationSeconds: DEFAULT_DIALOGUE_DURATION_SECONDS,
  scriptReadingSpeed: DEFAULT_SCRIPT_READING_SPEED,
  aiProse: {
    baseUrl: '',
    defaultModel: '',
    jsonOutputSupported: false,
    targetBatchSize: DEFAULT_AI_TARGET_BATCH_SIZE,
    maxConcurrentAiRequests: DEFAULT_MAX_CONCURRENT_AI_REQUESTS,
    effort: DEFAULT_AI_EFFORT,
  },
  masterVolume: 1.0,
  voiceVolume: 0.8,
  bgmVolume: 0.5,
  gptSovits: {
    apiHost: '127.0.0.1',
    apiPort: 9880,
    rootPath: '',
    modelRoots: [],
    referenceRoots: [],
  },
  dialogueSignatureText1: '',
  dialogueSignatureColor1: '#FFDADE',
  dialogueSignatureText2: '',
  dialogueSignatureColor2: '#CEA493',
  workbenchPanelWidth: 380,
  workbenchDetailWidth: 360,
  workbenchContextWidth: 400,
  workbenchTimelineHeight: 300,
  workbenchTimelineLayoutMode: 'tracks',
  workbenchDialogueFlowMode: 'manual',
  workbenchContextPanelOpen: false,
  workbenchContextTab: 'characters',
  keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS_SETTINGS,
};

class SettingsManager {
  private settings: AppSettings;
  readonly _listeners = new Set<() => void>();
  private keyListeners = new Map<keyof AppSettings, Set<() => void>>();

  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.load();

    if (typeof window === 'undefined') return;
    window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
      if (this.settings.theme === 'system') {
        this.applyTheme('system');
      }
    });
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.settings[key];
  }

  getAll(): AppSettings {
    return { ...this.settings };
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    const normalizedValue = this.normalizeValue(key, value);
    if (Object.is(this.settings[key], normalizedValue)) {
      return;
    }
    this.settings[key] = normalizedValue;
    this.save();
    this.apply(key, normalizedValue);
    this._notify([key]);
  }

  update(patch: Partial<AppSettings>) {
    const normalizedPatch = this.normalizePatch(patch);
    const changedEntries = Object.entries(normalizedPatch).filter(([key, value]) => (
      !Object.is(this.settings[key as keyof AppSettings], value)
    ));
    if (changedEntries.length === 0) {
      return;
    }

    this.settings = { ...this.settings, ...normalizedPatch };
    this.save();
    changedEntries.forEach(([key, value]) => {
      this.apply(key as keyof AppSettings, value as any);
    });
    this._notify(changedEntries.map(([key]) => key as keyof AppSettings));
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  subscribeKey<K extends keyof AppSettings>(key: K, listener: () => void): () => void {
    const listeners = this.keyListeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.keyListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.keyListeners.delete(key);
      }
    };
  }

  private _notify(changedKeys: Array<keyof AppSettings>): void {
    this._listeners.forEach((fn) => fn());
    changedKeys.forEach((key) => {
      this.keyListeners.get(key)?.forEach((fn) => fn());
    });
  }

  private load() {
    try {
      const storage = getSettingsStorage();
      const saved = storage?.getItem('aeonstagery_settings');
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<AppSettings> & {
          externalLibraryPaths?: unknown;
          apiKey?: unknown;
          credential?: unknown;
        };
        const {
          externalLibraryPaths,
          apiKey: _droppedApiKey,
          credential: _droppedCredential,
          ...currentSettings
        } = parsed;
        // Drop obsolete timelinePresentationPreferences from persisted settings.
        const { timelinePresentationPreferences: _droppedPreferences, ...restSettings } = currentSettings as Partial<AppSettings> & {
          timelinePresentationPreferences?: unknown;
        };
        const hasLegacyAnsySignature = restSettings.dialogueSignatureText1 === 'an'
          && restSettings.dialogueSignatureText2 === 'sy';
        this.settings = {
          ...DEFAULT_SETTINGS,
          ...restSettings,
          theme: normalizeTheme(restSettings.theme),
          dialogueSignatureText1: hasLegacyAnsySignature
            ? ''
            : restSettings.dialogueSignatureText1 ?? DEFAULT_SETTINGS.dialogueSignatureText1,
          dialogueSignatureText2: hasLegacyAnsySignature
            ? ''
            : restSettings.dialogueSignatureText2 ?? DEFAULT_SETTINGS.dialogueSignatureText2,
          recentProjects: Array.isArray(restSettings.recentProjects)
            ? restSettings.recentProjects.slice(0, MAX_RECENT_PROJECTS)
            : DEFAULT_SETTINGS.recentProjects,
          dialogueTextSpeed: restSettings.dialogueTextSpeed === undefined
            ? normalizeDialogueTextSpeed(restSettings.typewriterSpeed)
            : normalizeDialogueTextSpeed(restSettings.dialogueTextSpeed),
          dialogueEntranceAnimation: restSettings.dialogueEntranceAnimation !== false,
          dialogueFontSize: normalizeDialogueFontSize(restSettings.dialogueFontSize),
          defaultDialogueDurationSeconds: normalizeDefaultDialogueDurationSeconds(
            restSettings.defaultDialogueDurationSeconds,
          ),
          scriptReadingSpeed: normalizeScriptReadingSpeed(restSettings.scriptReadingSpeed),
          aiProse: normalizeAiProseSettings(
            restSettings.aiProse && typeof restSettings.aiProse === 'object'
              ? {
                  ...restSettings.aiProse,
                  baseUrl: (restSettings.aiProse as { baseUrl?: unknown }).baseUrl === DEFAULT_AI_BASE_URL
                    ? ''
                    : (restSettings.aiProse as { baseUrl?: unknown }).baseUrl,
                  defaultModel: (restSettings.aiProse as { defaultModel?: unknown }).defaultModel === DEFAULT_AI_MODEL
                    ? ''
                    : (restSettings.aiProse as { defaultModel?: unknown }).defaultModel,
                }
              : restSettings.aiProse,
          ),
          externalLibraryMounts: normalizeExternalLibraryMounts(
            restSettings.externalLibraryMounts,
            externalLibraryPaths,
          ),
          projectExternalLibraryBindings: normalizeProjectExternalLibraryBindings(
            restSettings.projectExternalLibraryBindings,
            // Legacy flat format written by the first project-binding iteration.
            (restSettings as { projectLibraryMountBindings?: unknown }).projectLibraryMountBindings,
          ),
          experimentalFeatureReadState: normalizeExperimentalFeatureReadState(
            restSettings.experimentalFeatureReadState,
          ),
          keyboardShortcuts: normalizeKeyboardShortcutsSettings(
            restSettings.keyboardShortcuts,
          ),
          workbenchTimelineLayoutMode: restSettings.workbenchTimelineLayoutMode === 'list'
            ? 'list'
            : 'tracks',
          workbenchDialogueFlowMode: restSettings.workbenchDialogueFlowMode === 'auto'
            ? 'auto'
            : 'manual',
          readAnnouncementIds: Array.isArray(restSettings.readAnnouncementIds)
            ? restSettings.readAnnouncementIds.filter((id): id is string => typeof id === 'string')
            : [],
          autoShowChangelogOnUpdate: typeof restSettings.autoShowChangelogOnUpdate === 'boolean'
            ? restSettings.autoShowChangelogOnUpdate
            : true,
          showLive2DRuntimeSetupOnStartup: typeof restSettings.showLive2DRuntimeSetupOnStartup === 'boolean'
            ? restSettings.showLive2DRuntimeSetupOnStartup
            : DEFAULT_SETTINGS.showLive2DRuntimeSetupOnStartup,
        };
        this.save();
      }
    } catch (e) {
      console.error('Failed to load settings', e);
    }

    Object.entries(this.settings).forEach(([key, value]) => {
      this.apply(key as keyof AppSettings, value as any);
    });
  }

  private save() {
    try {
      const storage = getSettingsStorage();
      if (!storage) return;
      storage.setItem('aeonstagery_settings', JSON.stringify(this.settings));
    } catch (e) {
      console.error('Failed to save settings', e);
    }
  }

  private apply(key: keyof AppSettings, value: any) {
    if (typeof document === 'undefined') return;
    switch (key) {
      case 'lowPerformance':
        document.documentElement.setAttribute('data-perf', value ? 'low' : 'high');
        break;
      case 'theme':
        this.applyTheme(value);
        break;
    }
  }

  private normalizePatch(patch: Partial<AppSettings>): Partial<AppSettings> {
    const normalized: Partial<AppSettings> = {};
    Object.entries(patch).forEach(([key, value]) => {
      if (key === 'apiKey' || key === 'credential') return;
      normalized[key as keyof AppSettings] = this.normalizeValue(
        key as keyof AppSettings,
        value as AppSettings[keyof AppSettings],
      ) as never;
    });
    return normalized;
  }

  private normalizeValue<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings[K] {
    switch (key) {
      case 'dialogueEntranceAnimation':
        return (value !== false) as AppSettings[K];
      case 'dialogueTextSpeed':
        return normalizeDialogueTextSpeed(value) as AppSettings[K];
      case 'dialogueFontSize':
        return normalizeDialogueFontSize(value) as AppSettings[K];
      case 'theme':
        return normalizeTheme(value) as AppSettings[K];
      case 'defaultDialogueDurationSeconds':
        return normalizeDefaultDialogueDurationSeconds(value) as AppSettings[K];
      case 'workbenchTimelineLayoutMode':
        return (value === 'list' ? 'list' : 'tracks') as AppSettings[K];
      case 'workbenchDialogueFlowMode':
        return (value === 'auto' ? 'auto' : 'manual') as AppSettings[K];
      case 'scriptReadingSpeed':
        return normalizeScriptReadingSpeed(value) as AppSettings[K];
      case 'aiProse':
        return normalizeAiProseSettings(value) as AppSettings[K];
      case 'externalLibraryMounts':
        return normalizeExternalLibraryMounts(value, undefined) as AppSettings[K];
      case 'projectExternalLibraryBindings':
        return normalizeProjectExternalLibraryBindings(value) as AppSettings[K];
      case 'recentProjects':
        return (Array.isArray(value) ? value.slice(0, MAX_RECENT_PROJECTS) : []) as AppSettings[K];
      default:
        return value;
    }
  }

  private applyTheme(theme: AppTheme) {
    if (typeof document === 'undefined') return;
    const isDark = theme === 'system'
      ? (typeof window !== 'undefined' && (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false))
      : theme === 'dark';

    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }
}

export function createExternalLibraryMount(
  path: string,
  existing: readonly ExternalLibraryMount[],
): ExternalLibraryMount {
  const normalizedPath = normalizeExternalLibraryPath(path);
  const baseName = normalizedPath.split('/').filter(Boolean).pop() ?? 'library';
  const baseId = slugifyMountId(baseName);
  const usedIds = new Set(existing.map((mount) => mount.id));
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    const suffixText = `-${suffix}`;
    id = `${baseId.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return { id, path: normalizedPath };
}

export function rebindExternalLibraryMount(
  mounts: readonly ExternalLibraryMount[],
  index: number,
  path: string,
): ExternalLibraryMount[] {
  const normalizedPath = normalizeExternalLibraryPath(path);
  return mounts.map((mount, mountIndex) => (
    mountIndex === index ? { ...mount, path: normalizedPath } : mount
  ));
}

export function hasExternalLibraryMountPath(
  mounts: readonly ExternalLibraryMount[],
  path: string,
): boolean {
  const pathKey = normalizeExternalLibraryPath(path).toLowerCase();
  return mounts.some((mount) => normalizeExternalLibraryPath(mount.path).toLowerCase() === pathKey);
}

export function normalizeExternalLibraryMounts(
  mounts: unknown,
  legacyPaths: unknown,
): ExternalLibraryMount[] {
  const normalized: ExternalLibraryMount[] = [];
  const candidates = Array.isArray(mounts)
    ? mounts
    : Array.isArray(legacyPaths)
      ? legacyPaths.map((path) => ({ path }))
      : [];

  for (const candidate of candidates) {
    const path = typeof candidate === 'string'
      ? candidate
      : candidate && typeof candidate === 'object' && typeof (candidate as { path?: unknown }).path === 'string'
        ? (candidate as { path: string }).path
        : '';
    if (!path.trim()) continue;
    const requestedId = candidate && typeof candidate === 'object' && typeof (candidate as { id?: unknown }).id === 'string'
      ? slugifyMountId((candidate as { id: string }).id)
      : undefined;
    const created = createExternalLibraryMount(path, normalized);
    normalized.push({ ...created, ...(requestedId && !normalized.some((mount) => mount.id === requestedId) ? { id: requestedId } : {}) });
  }
  return normalized;
}

/**
 * Normalize machine-local project bindings. Accepts the nested
 * `projectId → mountId → path` shape, folds the legacy flat
 * `projectId\u0000mountId → path` shape, and prunes entries that can never
 * resolve (blank ids, malformed mount ids, empty paths).
 */
export function normalizeProjectExternalLibraryBindings(
  value: unknown,
  legacyFlatValue?: unknown,
): ProjectExternalLibraryBindings {
  const normalized: ProjectExternalLibraryBindings = {};
  const mergeBinding = (projectIdRaw: unknown, mountIdRaw: unknown, pathRaw: unknown) => {
    if (typeof projectIdRaw !== 'string' || typeof mountIdRaw !== 'string' || typeof pathRaw !== 'string') return;
    const projectId = projectIdRaw.trim();
    const mountId = normalizeMountId(mountIdRaw);
    if (mountId === null) return;
    if (!projectId || !normalizeMountId(mountId)) return;
    const path = normalizeExternalLibraryPath(pathRaw);
    if (!path) return;
    normalized[projectId] = { ...(normalized[projectId] ?? {}), [mountId]: path };
  };

  if (isRecord(value)) {
    for (const [key, mounts] of Object.entries(value)) {
      if (key.includes('\u0000')) {
        const [projectId, mountId] = key.split('\u0000');
        mergeBinding(projectId, mountId, mounts);
        continue;
      }
      if (!isRecord(mounts)) continue;
      for (const [mountId, path] of Object.entries(mounts)) {
        mergeBinding(key, mountId, path);
      }
    }
  }

  if (isRecord(legacyFlatValue)) {
    for (const [key, path] of Object.entries(legacyFlatValue)) {
      if (!key.includes('\u0000')) continue;
      const [projectId, mountId] = key.split('\u0000');
      mergeBinding(projectId, mountId, path);
    }
  }

  return normalized;
}


export const DIALOGUE_TEXT_SPEED_SECONDS_RANGE = {
  min: 0.005,
  max: 0.2,
  step: 0.005,
} as const;

export const DIALOGUE_FONT_SIZE_RANGE = { min: 20, max: 96, step: 1 } as const;

export function normalizeDialogueFontSize(value: unknown): number {
  return normalizeNumberInRange(value, DIALOGUE_FONT_SIZE_RANGE.min, DIALOGUE_FONT_SIZE_RANGE.max, DEFAULT_SETTINGS.dialogueFontSize);
}

export function normalizeDialogueTextSpeed(value: unknown): number {
  return normalizeNumberInRange(
    value,
    DIALOGUE_TEXT_SPEED_SECONDS_RANGE.min,
    DIALOGUE_TEXT_SPEED_SECONDS_RANGE.max,
    DEFAULT_SETTINGS.dialogueTextSpeed,
  );
}

export function normalizeDefaultDialogueDurationSeconds(value: unknown): number {
  return normalizeManualDialogueDuration(value, DEFAULT_SETTINGS.defaultDialogueDurationSeconds);
}

export function normalizeScriptReadingSpeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SETTINGS.scriptReadingSpeed;
  }
  const clamped = Math.min(
    SCRIPT_READING_SPEED_RANGE.max,
    Math.max(SCRIPT_READING_SPEED_RANGE.min, value),
  );
  const stepped = Math.round(
    (clamped - SCRIPT_READING_SPEED_RANGE.min) / SCRIPT_READING_SPEED_RANGE.step,
  ) * SCRIPT_READING_SPEED_RANGE.step + SCRIPT_READING_SPEED_RANGE.min;
  return Number(stepped.toFixed(10));
}

export function normalizeAiProseSettings(value: unknown): AppSettings['aiProse'] {
  const candidate = isRecord(value) ? value : {};
  const modelOverrides: Partial<Record<AiProseStage, string>> = {};
  if (isRecord(candidate.modelOverrides)) {
    for (const stage of AI_PROSE_STAGES) {
      const model = candidate.modelOverrides[stage];
      if (typeof model === 'string' && model.trim().length > 0) {
        modelOverrides[stage] = model.trim();
      }
    }
  }

  const baseUrlCandidate = typeof candidate.baseUrl === 'string'
    ? candidate.baseUrl
    : candidate.endpoint;
  const baseUrl = typeof baseUrlCandidate === 'string' && baseUrlCandidate.trim().length > 0
    ? normalizeAiProseBaseUrl(baseUrlCandidate)
    : DEFAULT_SETTINGS.aiProse.baseUrl;
  const defaultModel = typeof candidate.defaultModel === 'string' && candidate.defaultModel.trim().length > 0
    ? candidate.defaultModel.trim()
    : DEFAULT_SETTINGS.aiProse.defaultModel;
  const projectAgentModel = typeof candidate.projectAgentModel === 'string'
    && candidate.projectAgentModel.trim().length > 0
    ? candidate.projectAgentModel.trim()
    : undefined;
  const targetBatchSize = isPositiveSafeInteger(candidate.targetBatchSize)
    ? candidate.targetBatchSize
    : DEFAULT_SETTINGS.aiProse.targetBatchSize;
  const maxConcurrentAiRequests = isPositiveSafeInteger(candidate.maxConcurrentAiRequests)
    ? candidate.maxConcurrentAiRequests
    : DEFAULT_SETTINGS.aiProse.maxConcurrentAiRequests;
  const effort = AI_PROSE_EFFORTS.includes(candidate.effort as AiProseEffort)
    ? candidate.effort as AiProseEffort
    : DEFAULT_SETTINGS.aiProse.effort;
  const provider = {
    baseUrl,
    defaultModel,
    ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
  };
  const capabilityIdentity = typeof candidate.capabilityIdentity === 'string'
    && candidate.capabilityIdentity.trim().length > 0
    && candidate.capabilityIdentity.trim() === getAiProseProviderIdentity(provider)
    ? candidate.capabilityIdentity.trim()
    : undefined;

  return {
    baseUrl,
    defaultModel,
    ...(projectAgentModel ? { projectAgentModel } : {}),
    ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
    ...(capabilityIdentity ? { capabilityIdentity } : {}),
    jsonOutputSupported: capabilityIdentity && candidate.jsonOutputSupported === true
      ? true
      : false,
    targetBatchSize,
    maxConcurrentAiRequests,
    effort,
  };
}

function normalizeAiProseBaseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/u, '');
    if (pathname.endsWith('/chat/completions')) {
      url.pathname = pathname.slice(0, -'/chat/completions'.length) || '/';
      return url.toString().replace(/\/$/u, '');
    }
    if (pathname.endsWith('/models')) {
      url.pathname = pathname.slice(0, -'/models'.length) || '/';
      return url.toString().replace(/\/$/u, '');
    }
    return url.toString().replace(/\/$/u, '');
  } catch {
    // Incomplete while typing (e.g. "https:/"), keep as is
  }
  return trimmed;
}

export function getDefaultDialogueDurationSeconds(): number {
  return settingsManager.get('defaultDialogueDurationSeconds');
}

function normalizeNumberInRange(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function getSettingsStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function slugifyMountId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'library';
}

function normalizeExternalLibraryPath(path: string): string {
  return path.replace(/\\/g, '/').trim().replace(/\/+$/, '');
}

export const settingsManager = new SettingsManager();

export function upsertRecentProject(entry: RecentProjectEntry) {
  const existing = settingsManager.get('recentProjects') || [];
  const deduped = existing.filter((item) => item.projectFilePath !== entry.projectFilePath && item.rootPath !== entry.rootPath);
  settingsManager.set('recentProjects', [entry, ...deduped].slice(0, MAX_RECENT_PROJECTS));
}

export function removeRecentProject(projectFilePath: string) {
  const existing = settingsManager.get('recentProjects') || [];
  settingsManager.set(
    'recentProjects',
    existing.filter((item) => item.projectFilePath !== projectFilePath),
  );
}

export const settingsProjectRecentsPort = {
  upsertRecentProject,
  removeRecentProject,
};

export const settingsProjectWorkflowSettingsPort = {
  setAssetsPath(path: string) {
    settingsManager.set('assetsPath', path);
  },
};

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(settingsManager.getAll());

  useEffect(() => {
    const listener = () => setSettings(settingsManager.getAll());
    return settingsManager.subscribe(listener);
  }, []);

  const setSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    settingsManager.set(key, value);
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    settingsManager.update(patch);
  }, []);

  return {
    settings,
    setSetting,
    updateSettings,
  };
}

export function useSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return useSyncExternalStore(
    (listener) => settingsManager.subscribeKey(key, listener),
    () => settingsManager.get(key),
    () => settingsManager.get(key),
  );
}
