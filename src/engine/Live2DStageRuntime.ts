/**
 * Live2D Stage Runtime
 *
 * Owns stage character state, command mailboxes, and the deterministic frame
 * commit used by the Live2D facade. Model loading/texture ownership remains in
 * Live2DModelResources; motion policy remains in Live2DMotionController.
 */

import * as PIXI from 'pixi.js';
import { isUtSystemLockActive } from './Live2DConfig';
import type { CharacterEntry } from './Live2DConfig';
import type { ModelSnapshot } from './Live2DConfig';
import type { CharacterMotionOutput } from '../api/types/semantic-scene';
import type { RimLightStyleState } from '../api/types/visual';
import type { ResolvedRimLightState } from './RimLightResolver';
import { cubism2Live2DAdapter, getLive2DRuntimeAdapter } from './Live2DRuntimeAdapter';
import { applyCustomMotionValues, evaluateCustomMotionRuntime } from './live2d/customMotionRuntime';
import type { MotionRequest } from './Live2DMotionController';

function isDefaultLive2DPose(snapshot: ModelSnapshot | null): boolean {
  if (!snapshot?.params?.length) return true;
  for (let i = 0; i < snapshot.params.length; i++) {
    if (snapshot.params[i] !== 0) return false;
  }
  return true;
}

export type PendingCustomMotion = {
  motion: Extract<CharacterMotionOutput, { kind: 'custom' }>;
  sceneTime: number;
  handoffSnapshot?: ModelSnapshot | null;
};

export type PendingLookAt = {
  focusX: number;
  focusY: number;
  duration: number;
  options?: { fromX?: number; fromY?: number; elapsed?: number; ease?: string };
};

export type PendingBlink = {
  enabled: boolean;
  intervalMs: number;
  sceneTimeSeconds?: number;
  startTimeSeconds?: number;
  intervalRangeMs?: number;
};

export type PendingRimLightCommand =
  | { mode: 'set'; color: string | number; intensity: number; thickness: number; angle: number; softness: number; duration: number; startTime?: number }
  | { mode: 'reset'; duration: number; baseline?: RimLightStyleState; startTime?: number };

type MotionQueueItem = { id: string; req: MotionRequest };

export interface Live2DStageRuntimeCallbacks {
  dispatchMotion: (id: string, request: MotionRequest) => Promise<void>;
  describeInvalidModelState: (entry: CharacterEntry) => string | null;
  repairCorruptedModel: (entry: CharacterEntry, reason: string, waitForRepair: boolean) => Promise<void>;
  maybeInstallCustomMotionStage: (entry: CharacterEntry) => void;
  resolveCustomMotionSceneTime: (entry: CharacterEntry, manualTimeMs?: number) => number;
  getScriptEngine: () => { isReconstructing?: boolean } | null;
}

export class Live2DStageRuntime {
  readonly characters = new Map<string, CharacterEntry>();
  readonly containers = new Map<string, PIXI.Container>();
  readonly pendingMotions = new Map<string, MotionRequest[]>();
  readonly characterGenerations = new Map<string, number>();
  readonly jumpingCharacters = new Set<string>();
  readonly motionMutex = new Map<string, Promise<void>>();
  readonly hardResetMutex = new Map<string, Promise<void>>();
  readonly pendingConfigs = new Map<string, unknown[]>();
  readonly activeMotionLoads = new Set<string>();
  readonly pendingExpressions = new Map<string, string | null>();
  readonly pendingCustomMotions = new Map<string, PendingCustomMotion>();
  readonly pendingLookAts = new Map<string, PendingLookAt>();
  readonly pendingBlinks = new Map<string, PendingBlink>();
  readonly pendingRimLightCommands = new Map<string, PendingRimLightCommand>();
  readonly pendingRimLightStates = new Map<string, ResolvedRimLightState>();

  private readonly pendingMotionQueue: MotionQueueItem[] = [];
  private pendingMotionCount = 0;
  private shouldUpdate = true;
  private tickerAdded = false;

  constructor(private readonly callbacks: Live2DStageRuntimeCallbacks) {}

  get isUpdating(): boolean {
    return this.shouldUpdate;
  }

  get hasTicker(): boolean {
    return this.tickerAdded;
  }

  markTickerAdded(): void {
    this.tickerAdded = true;
  }

  replaceCharacters(entries: ReadonlyMap<string, CharacterEntry>): void {
    this.characters.clear();
    for (const [id, entry] of entries) this.characters.set(id, entry);
  }

  replaceContainers(containers: ReadonlyMap<string, PIXI.Container>): void {
    this.containers.clear();
    for (const [id, container] of containers) this.containers.set(id, container);
  }

  setAutoUpdate(enabled: boolean): void {
    this.shouldUpdate = enabled;
    for (const entry of this.characters.values()) {
      entry.model.autoUpdate = false;
    }
  }

  nextCharacterGeneration(id: string): number {
    const next = (this.characterGenerations.get(id) ?? 0) + 1;
    this.characterGenerations.set(id, next);
    return next;
  }

  async waitForQuiescence(waitForResources: () => Promise<void>): Promise<void> {
    while (this.motionMutex.size > 0 || this.hardResetMutex.size > 0) {
      await Promise.allSettled([
        waitForResources(),
        ...this.motionMutex.values(),
        ...this.hardResetMutex.values(),
      ]);
    }
    await waitForResources();
  }

  async step(dt: number, forceStep: boolean = false, manualTimeMs?: number): Promise<void> {
    const sharedClockLocked = isUtSystemLockActive() && !forceStep && manualTimeMs === undefined;

    this.pendingMotionCount = 0;
    for (const entry of this.characters.values()) {
      if (sharedClockLocked && entry.runtime?.adapterId !== 'untitled-pixi-live2d-engine-cubism') continue;
      const request = (entry as any)._pendingPlayMotion as MotionRequest | undefined;
      if (!request) continue;
      (entry as any)._pendingPlayMotion = undefined;
      if (!this.pendingMotionQueue[this.pendingMotionCount]) {
        this.pendingMotionQueue[this.pendingMotionCount] = { id: '', req: request };
      }
      const item = this.pendingMotionQueue[this.pendingMotionCount];
      item.id = entry.id;
      item.req = request;
      this.pendingMotionCount++;
    }

    const motionPromises: Promise<void>[] = [];
    for (let i = 0; i < this.pendingMotionCount; i++) {
      const { id, req } = this.pendingMotionQueue[i];
      const promise = this.callbacks.dispatchMotion(id, req)
        .catch(error => console.error(`[Live2D] Background motion execution failed for ${id}:`, error));
      motionPromises.push(promise);
    }
    if (forceStep && motionPromises.length > 0) await Promise.all(motionPromises);

    let deltaInMs = dt;
    if (!this.shouldUpdate && !forceStep) deltaInMs = 0.0001;
    const shouldStepModels = deltaInMs > 0;
    deltaInMs = shouldStepModels ? Math.min(50, Math.max(0.001, deltaInMs)) : 0;

    const sdkClock = cubism2Live2DAdapter.getClock();
    if (sdkClock && !sharedClockLocked && this.jumpingCharacters.size === 0 && manualTimeMs === undefined) {
      sdkClock.setUserTimeMSec(sdkClock.getUserTimeMSec() + deltaInMs);
    }

    const scriptEngine = this.callbacks.getScriptEngine();
    for (const entry of this.characters.values()) {
      if (sharedClockLocked && entry.runtime?.adapterId !== 'untitled-pixi-live2d-engine-cubism') continue;
      if (entry.filterWarmupFrames && entry.filterWarmupFrames > 0 && !scriptEngine?.isReconstructing) {
        entry.filterWarmupFrames = Math.max(0, entry.filterWarmupFrames - 1);
      }

      if (entry.isCorrupted || entry.corruptionRepairPromise) {
        await this.callbacks.repairCorruptedModel(entry, 'previous invalid state', forceStep);
      } else {
        const invalidBeforeUpdate = this.callbacks.describeInvalidModelState(entry);
        if (invalidBeforeUpdate) await this.callbacks.repairCorruptedModel(entry, invalidBeforeUpdate, forceStep);
      }

      if (!entry.isCorrupted) {
        try {
          if (manualTimeMs !== undefined) entry.lastManualTimeMs = manualTimeMs;
          if (entry.customMotion) {
            this.callbacks.maybeInstallCustomMotionStage(entry);
            entry.customMotionStage?.setSceneTime(this.callbacks.resolveCustomMotionSceneTime(entry, manualTimeMs));
          }
          if (entry.pendingSeekBoundarySnapshot) {
            if (manualTimeMs === undefined) {
              entry.pendingSeekBoundarySnapshot = undefined;
              entry.pendingSeekBoundaryMotionStartTime = undefined;
              entry.pendingSeekBoundaryDuration = undefined;
            } else {
              const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
              const currentSnapshot = controls.captureSnapshot(entry.id, entry.model, entry.motionStartTime);
              if (isDefaultLive2DPose(currentSnapshot)) {
                controls.applySnapshot(entry.model, entry.pendingSeekBoundarySnapshot);
              } else {
                entry.pendingSeekBoundarySnapshot = undefined;
                entry.pendingSeekBoundaryMotionStartTime = undefined;
                entry.pendingSeekBoundaryDuration = undefined;
              }
            }
          }

          const freezeNativeMotion = !this.shouldUpdate
            && !forceStep
            && entry.runtime?.adapterId === 'untitled-pixi-live2d-engine-cubism';
          // Cubism 3+ evaluates cached motion writers and native queues inside
          // update(), including at delta 0. A forced seek flush must commit
          // that pose before rendering without advancing the paused clock.
          const commitNativeSeek = forceStep && entry.runtime?.adapterId === 'untitled-pixi-live2d-engine-cubism';
          if ((shouldStepModels || commitNativeSeek) && !freezeNativeMotion) {
            getLive2DRuntimeAdapter(entry.runtime).getControls().advanceFrame(entry.model, deltaInMs);
          }

          const invalidAfterUpdate = this.callbacks.describeInvalidModelState(entry);
          if (invalidAfterUpdate) await this.callbacks.repairCorruptedModel(entry, invalidAfterUpdate, forceStep);
        } catch {
          // Keep the existing per-character isolation: one SDK failure must not stop the frame.
        }
      }

      if (entry.isCorrupted) continue;
      if (!entry.customMotionStage && entry.customMotion && entry.customMotionHandoff) {
        const sceneTime = this.callbacks.resolveCustomMotionSceneTime(entry, manualTimeMs);
        const evaluation = evaluateCustomMotionRuntime(
          entry.customMotion.motion,
          entry.customMotion.startSceneTime,
          sceneTime,
          entry.customMotionHandoff,
        );
        applyCustomMotionValues(
          entry.injectedParams,
          entry.customMotion.controlledParameterIds,
          evaluation.values,
          entry.lipSyncParameterIds,
        );
      }

      if (entry.injectedParams) {
        const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
        for (const [key, value] of Object.entries(entry.injectedParams)) {
          controls.setInjectedParameter(entry.model, key, value);
        }
        controls.syncInputParameters(entry.model);
      }

      if (entry.pendingLipSyncRelease && entry.pendingLipSyncRelease.size > 0) {
        for (const parameterId of entry.pendingLipSyncRelease) delete entry.injectedParams[parameterId];
        entry.pendingLipSyncRelease.clear();
      }
    }

    for (const container of this.containers.values()) {
      if ((container as any)._filtersDirty) {
        (container as any)._filtersDirty = false;
        container.filters = container.filters ? (container.filters as any[]).slice() : null;
      }
    }
  }

  clear(): void {
    this.characters.clear();
    this.containers.clear();
    this.pendingMotions.clear();
    this.pendingConfigs.clear();
    this.pendingExpressions.clear();
    this.pendingCustomMotions.clear();
    this.pendingLookAts.clear();
    this.pendingBlinks.clear();
    this.pendingRimLightCommands.clear();
    this.pendingRimLightStates.clear();
    this.motionMutex.clear();
    this.hardResetMutex.clear();
    this.characterGenerations.clear();
    this.activeMotionLoads.clear();
    this.jumpingCharacters.clear();
    this.pendingMotionCount = 0;
  }
}
