import type { LayerName, Vec2 } from './common';
import type { UpdateSource, UpdateStatus } from './updater';
import type {
  CameraMoveConfig,
  CameraShakeConfig,
  CameraKeyframe,
  CameraPathConfig,
  CameraFollowConfig,
  CameraHitchcockConfig,
  CameraState,
  CameraMotionConfig,
} from './camera';
import type { CharacterConfig, CharacterTransformConfig } from './character';
import type { ExportConfig, ExportProgress, ExportResult } from './export';
import type { HookEvent, HookContext } from './hook';
import type {
  WorkspaceRuntimeSnapshot,
  WorkspaceToolsCommand,
  WorkspaceToolsCommandResult,
  WorkspaceToolsSnapshot,
  WorkspaceToolsWindowState,
} from '../../ui/workspace-tools/types';
import type {
  GptSovitsGenerateDialogueVoiceRequest,
  GptSovitsGenerateDialogueVoiceResult,
  GptSovitsLocalConfig,
  GptSovitsStartResult,
  GptSovitsStatusResult,
  GptSovitsStopResult,
} from '../../services/voice/GptSovitsTypes';
import type {
  AiProseCapabilityProbeRequest,
  AiProseCredentialStatus,
  AiProseModelListResult,
  AiProseModelCapabilities,
  AiProseProviderConfig,
} from './ai-prose-authoring';
import type {
  GenerateVoiceCandidateRequest,
  LocalVoicePresetResult,
  SaveLocalVoicePresetRequest,
  ScanVoiceCatalogRequest,
  VoiceCandidateResult,
  VoiceCatalogResult,
  VoiceLibraryResult,
  PublishTemplateVoiceProfileResult,
} from '../../services/voice/VoiceAuthoringTypes';
import type {
  AiProseLlmProgress,
  AiProseLlmRequest,
  AiProseLlmResponse,
} from '../../services/ai-authoring/AiProseContracts';
import type { AiConversationIpc } from './ai-conversation-ipc';
import type {
  ProjectAgentAcknowledgeReportResult,
  ProjectAgentBeginTaskRequest,
  ProjectAgentBeginTaskResult,
  ProjectAgentDeleteConversationResult,
  ProjectAgentJournalSaveOutcome,
  ProjectAgentProjectContext,
  ProjectAgentRenameConversationResult,
  ProjectAgentStartRequest,
  ProjectAgentStartResultPayload,
  ProjectAgentTerminalCommandRequest,
  ProjectAgentTerminalCommandResponse,
  ProjectAgentTaskStatusPayload,
} from './project-agent-ipc';
import type {
  ProjectAgentEditorCommand,
  ProjectAgentTaskCommandResult,
} from '../../services/project-agent-service/ProjectAgentTaskCoordinator';
import type {
  ProjectAgentLeaseAcquireResult,
  ProjectAgentLeaseHandle,
  ProjectAgentLeaseReleaseResult,
} from '../../services/project-agent/ProjectAgentLease';
import type {
  ProjectAgentJournalRecord,
} from '../../services/project-agent/ProjectAgentJournal';
import type {
  ProjectAgentPauseReason,
} from '../../services/project-agent/ProjectAgentTask';
import type { TemplatePackageImportResult } from './template-package-import';

export interface CollaborationSessionSummary {
  name: string;
  dataDir: string;
  sizeBytes: number;
  updatedAt: string;
  hasState: boolean;
  active: boolean;
}

export interface AeonStageryElectronAPI {
  fs: {
    readFile(path: string): Promise<{ success: boolean; data?: ArrayBuffer; error?: string }>;
    readTextFile(path: string): Promise<{ success: boolean; data?: string; error?: string }>;
    readDir(path: string): Promise<{
      success: boolean;
      data?: Array<{ name: string; isDirectory: boolean; isSymbolicLink?: boolean; path: string }>;
      error?: string;
    }>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{
      success: boolean;
      data?: {
        isFile: boolean;
        isDirectory: boolean;
        isSymbolicLink: boolean;
        sizeBytes: number;
        mtimeMs: number;
      };
      error?: string;
    }>;
    realpath(path: string): Promise<{ success: boolean; data?: string; error?: string }>;
    writeFile(path: string, data: ArrayBuffer): Promise<{ success: boolean; error?: string }>;
    writeTextFile(path: string, data: string): Promise<{ success: boolean; error?: string }>;
    replaceFile(temporaryPath: string, destinationPath: string): Promise<{ success: boolean; error?: string }>;
    ensureDir(path: string): Promise<{ success: boolean; error?: string }>;
    copyFile(sourcePath: string, destPath: string): Promise<{ success: boolean; error?: string }>;
    removeFile(path: string): Promise<{ success: boolean; error?: string }>;
  };
  dialog: {
    showSave(options: any): Promise<{ canceled: boolean; filePath?: string }>;
    showOpen(options: any): Promise<{ canceled: boolean; filePaths?: string[] }>;
  };
  templates?: {
    importZip(): Promise<TemplatePackageImportResult>;
  };
  app: {
    getPath(): Promise<string>;
    getProjectPath(): Promise<string>;
    getUserDataPath(): Promise<string>;
    getDefaultProjectsPath(): Promise<string>;
    restart(): Promise<{ success: boolean }>;
    openExternal?(url: string): Promise<{ success: boolean }>;
  };
  aiProse: {
    complete(request: AiProseLlmRequest): Promise<AiProseLlmResponse>;
    onProgress?(callback: (progress: AiProseLlmProgress) => void): () => void;
    probeCapabilities(request: AiProseCapabilityProbeRequest): Promise<AiProseModelCapabilities>;
    listModels?(baseUrl: string): Promise<AiProseModelListResult>;
    /**
     * Fire-and-forget cancellation of an in-flight completion. Absent when
     * the running preload predates the channel.
     */
    cancel?(requestId: string): void;
    configureProvider(provider: AiProseProviderConfig): Promise<{ success: boolean; error?: string }>;
    getCredentialStatus(): Promise<AiProseCredentialStatus>;
    setCredential(value: string): Promise<{ success: boolean; error?: string }>;
    clearCredential(): Promise<{ success: boolean; error?: string }>;
  };
  conversation: AiConversationIpc;
  /**
   * Project Agent host surface (ADR0023): editor renderer ↔ main coordinator
   * ↔ Agent window. Main owns the global running lease and the atomic
   * local-data-dir journal; taskId + lease token stay on this surface only.
   */
  projectAgent?: {
    beginTask(request: ProjectAgentBeginTaskRequest): Promise<ProjectAgentBeginTaskResult>;
    acquireLease(projectId: string, taskId: string): Promise<ProjectAgentLeaseAcquireResult>;
    releaseLease(leaseToken: string): Promise<ProjectAgentLeaseReleaseResult>;
    getLeaseHolder(): Promise<ProjectAgentLeaseHandle | null>;
    journalLoad(projectId: string, taskId: string): Promise<ProjectAgentJournalRecord | null>;
    journalSave(record: ProjectAgentJournalRecord): Promise<ProjectAgentJournalSaveOutcome>;
    journalListByProject(projectId: string): Promise<readonly ProjectAgentJournalRecord[]>;
    publishTaskStatus(status: ProjectAgentTaskStatusPayload): Promise<boolean>;
    getTaskStatus(taskId?: string): Promise<ProjectAgentTaskStatusPayload | null>;
    sendSupplement(taskId: string, text: string): Promise<{ ok: boolean; error?: string }>;
    requestStart(payload: ProjectAgentStartRequest): Promise<{ ok: boolean; error?: string }>;
    runTerminalCommand?(request: ProjectAgentTerminalCommandRequest): Promise<ProjectAgentTerminalCommandResponse>;
    cancelTerminalCommand?(requestId: string): Promise<void>;
    requestPause(taskId: string, reason: ProjectAgentPauseReason): Promise<ProjectAgentTaskCommandResult>;
    requestCancel(taskId: string): Promise<ProjectAgentTaskCommandResult>;
    requestContinue(taskId: string): Promise<ProjectAgentTaskCommandResult>;
    requestDiscard(taskId: string): Promise<ProjectAgentTaskCommandResult>;
    /**
     * User-only conversation deletion (ADR0023): removes the conversation
     * record entirely and releases any lease it holds; never rolls back
     * committed scene changes; idempotent for nonexistent conversations.
     * The conversationId is the conversation's stable store identity
     * (=== its taskId).
     */
    deleteConversation(projectId: string, conversationId: string): Promise<ProjectAgentDeleteConversationResult>;
    /**
     * User-only conversation rename (ADR0023): `userRename` overrides the
     * deterministic auto title; an empty name clears the rename. The rename
     * is never auto-derived and never reverted by later editor saves.
     */
    renameConversation(projectId: string, conversationId: string, name: string): Promise<ProjectAgentRenameConversationResult>;
    /**
     * Agent-window conversation switch (ADR0023): re-hydrates the editor's
     * single in-memory coordinator slot from the target conversation's
     * durable record. Refused while another execution round is running.
     */
    switchConversation(projectId: string, conversationId: string): Promise<ProjectAgentTaskCommandResult>;
    publishRestoredProject(projectId: string): Promise<void>;
    acknowledgeReport(taskId: string): Promise<ProjectAgentAcknowledgeReportResult>;
    /**
     * Agent window model switch: main relays to the editor renderer, which
     * updates the shared settings store (live provider hot-update).
     */
    setAgentModel(model: string): Promise<{ ok: boolean; error?: string }>;
    /**
     * Agent window effort switch: main relays to the editor renderer, which
     * updates the shared aiProse effort setting (live provider hot-update).
     */
    setEffort(effort: string): Promise<{ ok: boolean; error?: string }>;
    /**
     * Agent window settings entry: main relays an open-settings command to
     * the editor renderer.
     */
    requestOpenSettings(): Promise<{ ok: boolean; error?: string }>;
    /** Editor-published presentation context push/pull (Agent window). */
    publishProjectContext(context: ProjectAgentProjectContext): Promise<void>;
    getProjectContext(): Promise<ProjectAgentProjectContext | null>;
    /** Editor start-result relay (correlated by requestId; Agent window). */
    publishStartResult(payload: ProjectAgentStartResultPayload): Promise<void>;
    onContext(callback: (context: ProjectAgentProjectContext) => void): () => void;
    onStartResult(callback: (payload: ProjectAgentStartResultPayload) => void): () => void;
    onStatus(callback: (status: ProjectAgentTaskStatusPayload) => void): () => void;
    onSupplement(callback: (payload: { taskId: string; text: string }) => void): () => void;
    onStartRequest(callback: (payload: ProjectAgentStartRequest) => void): () => void;
    onSetModel(callback: (model: string) => void): () => void;
    onSetEffort(callback: (effort: string) => void): () => void;
    onCommand(callback: (command: ProjectAgentEditorCommand) => void): () => void;
    openWindow(): Promise<{ success: boolean }>;
  };
  betaState?: {
    load(kind: 'experimental-features' | 'first-lesson'): Promise<unknown>;
    save(kind: 'experimental-features' | 'first-lesson', value: unknown): Promise<{ success: boolean; error?: string }>;
  };
  collaborationServer: {
    start(options: { projectId: string; host?: string; port?: number; password?: string }): Promise<{
      success: boolean;
      reused?: boolean;
      status?: {
        running: boolean;
        host: string;
        port: number;
        dataDir: string;
        localUrl: string;
        lanUrls: string[];
        connectionPassword?: string;
        accessToken?: string;
        inviteUrls?: string[];
        assetRoot: string;
        hasState: boolean;
      };
      error?: string;
    }>;
    stop(): Promise<{ success: boolean; error?: string }>;
    getStatus(): Promise<{
      success: boolean;
      status?: {
        running: boolean;
        host: string;
        port: number;
        dataDir: string;
        localUrl: string;
        lanUrls: string[];
        connectionPassword?: string;
        accessToken?: string;
        inviteUrls?: string[];
        assetRoot: string;
        hasState: boolean;
      } | null;
      error?: string;
    }>;
    listSessions(): Promise<{
      success: boolean;
      sessions?: CollaborationSessionSummary[];
      error?: string;
    }>;
    clearPreviousSessions(): Promise<{
      success: boolean;
      clearedCount?: number;
      skippedActiveCount?: number;
      error?: string;
    }>;
  };
  export: {
    saveVideo(buffer: ArrayBuffer, path: string): Promise<{ success: boolean; error?: string }>;
    convert(inputPath: string, outputPath: string, options?: any): Promise<{ success: boolean; error?: string; stderr?: string; path?: string }>;
    getTempDir(): Promise<string>;
    startStreamExport(outputPath: string, options?: { fps?: number; width?: number; height?: number; codec?: string; crf?: number; vflip?: boolean; isEncoded?: boolean; bitrate?: number }): Promise<{ success: boolean; error?: string }>;
    pushFrame(frameData: Uint8Array | Uint8ClampedArray): Promise<{ success: boolean; error?: string }>;
    pushEncodedChunk(chunkData: Uint8Array): Promise<{ success: boolean; error?: string }>;
    endStreamExport(): Promise<{ success: boolean; error?: string }>;
    onLog(callback: (msg: string) => void): () => void;
  };
  path: {
    join(...args: string[]): Promise<string>;
    dirname(path: string): Promise<string>;
    basename(path: string): Promise<string>;
    extname(path: string): Promise<string>;
    relative(from: string, to: string): Promise<string>;
    normalize(path: string): Promise<string>;
    isAbsolute(path: string): Promise<boolean>;
  };
  updater: {
    getState(): Promise<{ enabled: boolean; feedUrlConfigured: boolean; appVersion: string; currentVersion: string; sources?: UpdateSource[] } & Partial<UpdateStatus>>;
    checkForUpdates(source?: UpdateSource): Promise<{ success: boolean; source?: UpdateSource; updateAvailable?: boolean; version?: string | null; releaseName?: string | null; releaseDate?: string | null; notes?: unknown; error?: string }>;
    downloadUpdate(): Promise<{ success: boolean; source?: UpdateSource; files?: string[]; error?: string }>;
    installUpdate(): Promise<{ success: boolean; error?: string }>;
    onStatus(callback: (status: UpdateStatus) => void): () => void;
  };
  gptSovits: {
    status(config: Partial<GptSovitsLocalConfig>): Promise<GptSovitsStatusResult>;
    start(config: Partial<GptSovitsLocalConfig>): Promise<GptSovitsStartResult>;
    stop(): Promise<GptSovitsStopResult>;
    generateDialogueVoice(input: GptSovitsGenerateDialogueVoiceRequest): Promise<GptSovitsGenerateDialogueVoiceResult>;
  };
  voiceAuthoring: {
    scanCatalog(request: ScanVoiceCatalogRequest): Promise<VoiceCatalogResult>;
    pickReferenceAudio(multiple: boolean): Promise<string[]>;
    listPresets(): Promise<VoiceLibraryResult>;
    resolveReference(presetId: string, referenceId: string): Promise<{ success: boolean; absolutePath?: string; error?: string }>;
    savePreset(request: SaveLocalVoicePresetRequest): Promise<LocalVoicePresetResult>;
    renamePreset(presetId: string, name: string): Promise<LocalVoicePresetResult>;
    duplicatePreset(presetId: string, name?: string): Promise<LocalVoicePresetResult>;
    deletePreset(presetId: string): Promise<VoiceLibraryResult>;
    publishTemplateProfile(presetId: string): Promise<PublishTemplateVoiceProfileResult>;
    generateCandidate(request: GenerateVoiceCandidateRequest): Promise<VoiceCandidateResult>;
    clearSession(sessionId: string): Promise<{ success: boolean; error?: string }>;
  };
  live2dRuntime?: {
    /** Main-process view of which runtime families were seeded into userData. */
    getAvailability(): Promise<{ cubism2: boolean; cubism3Plus: boolean } | null>;
    getStatus?(): Promise<import('./live2dRuntime').Live2DRuntimeStatusReport | null>;
    refreshStatus?(): Promise<import('./live2dRuntime').Live2DRuntimeStatusReport | null>;
    openDirectory?(type?: 'local' | 'runtime'): Promise<{ success: boolean; path?: string }>;
  };
  workspaceTools?: {
    open(): Promise<{ success: boolean }>;
    close(): Promise<{ success: boolean }>;
    getWindowState(): Promise<WorkspaceToolsWindowState>;
    requestSnapshot(): Promise<{ success: boolean }>;
    publishSnapshot(snapshot: WorkspaceToolsSnapshot): void;
    publishRuntime(snapshot: WorkspaceRuntimeSnapshot): void;
    publishCommandResult(result: WorkspaceToolsCommandResult): void;
    sendCommand(command: WorkspaceToolsCommand): void;
    onSnapshot(callback: (snapshot: WorkspaceToolsSnapshot) => void): () => void;
    onRuntime(callback: (snapshot: WorkspaceRuntimeSnapshot) => void): () => void;
    onCommand(callback: (command: WorkspaceToolsCommand) => void): () => void;
    onCommandResult(callback: (result: WorkspaceToolsCommandResult) => void): () => void;
    onSnapshotRequest(callback: () => void): () => void;
    onWindowState(callback: (state: WorkspaceToolsWindowState) => void): () => void;
  };
}

declare global {
  interface Window {
    aeonStageryAPI: AeonStageryElectronAPI;
    AeonStagery: AeonStageryPublicAPI;
  }
}

export interface AeonStageryPublicAPI {
  character: CharacterAPI;
  lipSync: LipSyncAPI;
  camera: CameraAPI;
  animation: AnimationAPI;
  scene: SceneAPI;
  export: ExportAPI;
  hooks: HookAPI;
  stage: StageAPI;
  adapters?: any;
  stores?: any;
  services?: any;
}

export interface StageAPI {
  getApp(): any; // PixiJS Application
  getWidth(): number;
  getHeight(): number;
  /** Get a named layer container for advanced compositing */
  getLayer(name: LayerName): any;
}

export interface CharacterAPI {
  add(id: string, modelPath: string, config?: CharacterConfig): Promise<void>;
  remove(id: string, exitAnimation?: string, duration?: number): Promise<void>;
  moveTo(id: string, position: Vec2, duration: number, ease?: string): void;
  /** Upgrade move to transform: supports position, scale, rotation, opacity */
  transform(id: string, config: CharacterTransformConfig): void;
  /** Set character focus (look at) in range [-1, 1] */
  lookAt(id: string, focusX: number, focusY: number, duration?: number): void;
  /** Toggle auto-blink and set interval */
  setBlink(id: string, enabled: boolean, interval?: number): void;
  playMotion(id: string, motionKey: string): void;
  setExpression(id: string, expressionName: string): void;
  setScale(id: string, scale: number, duration?: number, ease?: string): void;
  setOpacity(id: string, opacity: number, duration?: number, ease?: string): void;
  /** Set z-index ordering */
  setZIndex(id: string, zIndex: number): void;
  /** Get available motion keys for a character */
  getMotions(id: string): string[];
  /** Get the raw PixiJS Live2D model for advanced manipulation */
  getModel(id: string): any;
  /** Get the normalized bounds/points of a character for cinematic framing */
  getPoint(id: string, pointName: 'head' | 'chest' | 'feet' | 'center'): Vec2 | null;
  /** List all active characters */
  list(): string[];
}

export interface LipSyncAPI {
  startText(characterId: string, text: string, duration: number): void;
  startAudio(characterId: string, audioUrl: string): Promise<void>;
  stop(characterId: string): void;
  /** Adjust lip sync sensitivity */
  setSensitivity(characterId: string, sensitivity: number): void;
}

export interface CameraAPI {
  /**
   * Pan the camera to a target position.
   * Position is in normalized coords [0-1, 0-1] where (0.5, 0.5) is center.
   */
  panTo(target: Vec2, duration: number, ease?: string): void;

  /**
   * Zoom to a specific scale level. 1.0 = default, 2.0 = 2x zoom, etc.
   */
  zoomTo(scale: number, duration: number, ease?: string): void;

  /**
   * Simultaneous pan + zoom for cinematic moves.
   * This is the primary method for complex camera work.
   */
  moveTo(config: CameraMoveConfig): void;

  /** Camera shake effect */
  shake(config?: CameraShakeConfig): void;

  /** Rotate the camera */
  rotateTo(angle: number, duration: number, ease?: string): void;

  /** Smoothly reset camera to default position */
  reset(duration?: number, ease?: string): void;

  /**
   * Create a complex camera path with multiple keyframes.
   * Each keyframe specifies position, zoom, rotation, and timing.
   * This is the most powerful method for cinematic camera work.
   */
  createPath(keyframes: CameraKeyframe[], config?: CameraPathConfig): void;

  /**
   * Follow a character with the camera.
   * The camera will smoothly track the character's position.
   */
  follow(characterId: string, config?: CameraFollowConfig): void;

  /** Stop following a character */
  unfollow(): void;

  /** Get current camera state */
  getState(): CameraState;

  /**
   * Create a reusable camera animation that can be triggered later.
   * Returns a unique ID for the preset.
   */
  createPreset(name: string, keyframes: CameraKeyframe[]): string;

  /** Play a previously created camera preset */
  playPreset(name: string): void;

  /**
   * Hitchcock / Dolly Zoom with Y-axis dynamic compensation.
   * Simultaneously animates camera zoom and character scale while
   * recalculating targetY every frame to keep a body part at a fixed
   * screen position. Satisfies S·Z = constant throughout the animation.
   */
  hitchcockZoom(config: CameraHitchcockConfig): void;

  /**
   * Execute a semantic camera motion.
   * Combines a physical move type (push/pull/pan/tilt/zoom/rotate/dolly/shake)
   * with an emotional easing profile (smooth/accelerate/overshoot/linear/...).
   * Multiple motions on the same timeline segment compose naturally —
   * e.g. push + shake = tense handheld approach.
   */
  executeMotion(config: CameraMotionConfig): void;
}

export interface AnimationAPI {
  /** Play a custom HTML animation */
  playCustom(htmlFile: string, duration: number, layer?: LayerName): void;
  /** Get the GSAP master timeline for advanced control */
  getMasterTimeline(): any;
  /** Create a sub-timeline that can be composed into the master */
  createTimeline(label?: string): any;
  /** Add a GSAP tween to the master timeline at a specific time */
  addTween(time: number, target: any, vars: any): void;
  /** Register a custom animation preset */
  registerPreset(name: string, factory: (target: any, config: any) => any): void;
  /** Play a registered preset */
  playPreset(name: string, target: any, config?: any): void;
}

export interface SceneAPI {
  load(sceneJsonPath: string): Promise<void>;
  play(): void;
  pause(): void;
  seek(time: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  isPlaying(): boolean;
}

export interface ExportAPI {
  export(config: ExportConfig, onProgress: (p: ExportProgress) => void): Promise<ExportResult>;
}

export interface HookAPI {
  /** Register a hook handler */
  on(event: HookEvent, handler: (ctx: HookContext) => void | Promise<void>): void;
  /** Remove a hook handler */
  off(event: HookEvent, handler: (ctx: HookContext) => void | Promise<void>): void;
  /** Emit a custom event */
  emit(event: string, payload?: any): void;
}
