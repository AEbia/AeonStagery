/** Owns custom-motion takeover, handoff identity and Motion-stage installation. */
import { getLive2DRuntimeCapabilities } from './runtime/Live2DRuntimeControlModule';
import type { CharacterMotionOutput } from '../../api/types/semantic-scene';
import type { CharacterEntry, ModelSnapshot } from '../Live2DConfig';
import { getLive2DRuntimeAdapter } from '../Live2DRuntimeAdapter';
import { customMotionControlledParameterIds, selectHandoffPoseValues, type CustomMotionHandoffPose } from './customMotionRuntime';
import { releaseCustomMotionOwnership, reclaimControlledInjectedParams } from './customMotionOwnership';
import { restoreNeutralModelPose } from './characterStatePurge';

export class Live2DCustomMotionRuntime {
  /** Equal seek handoffs retain the deterministic fade cache across purges. */
  private readonly seekHandoffs = new WeakMap<CharacterEntry, CustomMotionHandoffPose>();

  constructor(private readonly getSceneTime: () => number | undefined) {}

  /** Preview replacements reuse the block's start pose, never saved fade frames. */
  getPreviewHandoff(entry: CharacterEntry | undefined, sceneTime: number): CustomMotionHandoffPose | undefined {
    if (entry?.customMotion?.startSceneTime !== sceneTime || !entry.customMotionHandoff) return;
    return { values: Object.fromEntries(Object.entries(entry.customMotionHandoff.values)
      .filter(([parameterId]) => !entry.lipSyncParameterIds?.has(parameterId))) };
  }

  start(
    entry: CharacterEntry,
    motion: Extract<CharacterMotionOutput, { kind: 'custom' }>,
    sceneTime: number,
    handoffSnapshot?: ModelSnapshot | null,
    previewHandoff?: CustomMotionHandoffPose,
  ): void {
    releaseCustomMotionOwnership(entry);
    entry.customMotion = {
      motion,
      startSceneTime: sceneTime,
      controlledParameterIds: customMotionControlledParameterIds(motion),
    };
    entry.customMotionHandoff = previewHandoff ?? this.captureCustomMotionHandoff(entry, handoffSnapshot);
    this.takeOverCustomMotion(entry);
  }

  private takeOverCustomMotion(entry: CharacterEntry): void {
    if (entry._pendingPlayMotion) {
      entry._pendingPlayMotion = undefined;
      entry.motionEpoch++;
    }
    // 自定义动作接管后，资源动作的 seek 边界保持快照已失效；若不清理，
    // 暂停拖动落在边界窗口内时它仍会每帧覆盖自定义动作的基线姿态。
    entry.pendingSeekBoundarySnapshot = undefined;
    entry.pendingSeekBoundaryMotionStartTime = undefined;
    entry.pendingSeekBoundaryDuration = undefined;
    // 收回受控参数的历史注入值：舞台模式下曲线在 model.update 内写入，
    // updateAll 的重放循环仍会把 injectedParams 残留值 post-update 写回，
    // 每帧压过曲线与表情叠加。必须在接管入口清洗（lip-sync 通道豁免）。
    // 放在 model 守卫之前：模型未就绪的接管同样要清掉陈旧值。
    reclaimControlledInjectedParams(entry);
    if (!entry.model) return;
    const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
    controls.stopAllMotions(entry.model);
    this.restoreCustomMotionBaseline(entry);
    for (const [parameterId, value] of Object.entries(entry.customMotionHandoff?.values ?? {})) {
      controls.setInjectedParameter(entry.model, parameterId, value);
    }
    controls.syncInputParameters(entry.model);
    this.ensureStage(entry);
  }

  /**
   * Install the Motion-stage writer exactly once per custom-motion takeover.
   *
   * Called from takeOverCustomMotion and lazily re-invoked by updateAll so a
   * motion that started before its model finished loading still gets staged
   * once the model arrives. A failed install (runtime without the writable
   * parameter seam) is recorded per custom-motion state
   * object — otherwise updateAll would retry the (always failing) install
   * every frame.
   */
  private readonly stageInstallAttempts = new WeakSet<object>();

  ensureStage(entry: CharacterEntry): void {
    if (!entry.customMotion || !entry.customMotionHandoff || !entry.model) return;
    if (entry.customMotionStage) return;
    if (this.stageInstallAttempts.has(entry.customMotion)) return;
    this.stageInstallAttempts.add(entry.customMotion);
    this.installCustomMotionStageOnEntry(entry);
  }

  /**
   * Install the Motion-stage writer so curve values enter the SDK update pass
   * before saveParam/expression compositing — an active Expression keeps
   * layering above them until the next expression or `default` (ADR-0029).
   * When the runtime lacks the emitter seam or a writable parameter target
   * the handle stays null and the legacy post-update injection path in
   * updateAll applies instead.
   */
  private installCustomMotionStageOnEntry(entry: CharacterEntry): void {
    entry.customMotionStage?.dispose();
    entry.customMotionStage = null;
    if (!entry.model) return;
    // Concrete-target resolution and the emitter/parameter checks live in the
    // runtime adapter; the stage handle type is unchanged.
    entry.customMotionStage = getLive2DRuntimeAdapter(entry.runtime).getControls().installCustomMotionStage(entry.model, {
      getState: () => entry.customMotion && entry.customMotionHandoff
        ? {
            motion: entry.customMotion.motion,
            startSceneTime: entry.customMotion.startSceneTime,
            handoff: entry.customMotionHandoff,
            controlledParameterIds: entry.customMotion.controlledParameterIds,
          }
        : null,
      lipSyncParameterIds: entry.lipSyncParameterIds,
    });
  }

  /**
   * Restore parameters the custom motion does not cover to their idle values,
   * mirroring the hard reset the resource-motion path performs before starting
   * (ADR-0029: the custom motion owns only its listed tracks; the rest of the
   * body must not stay frozen in the predecessor motion's pose).
   */
  private restoreCustomMotionBaseline(entry: CharacterEntry): void {
    if (!entry.model) return;
    if (!getLive2DRuntimeCapabilities(entry).usesCubism2PrivateControls && getLive2DRuntimeCapabilities(entry).supportsSnapshot) {
      if (entry.idleSnapshot) {
        getLive2DRuntimeAdapter(entry.runtime).getControls().applySnapshot(entry.model, entry.idleSnapshot);
      }
      return;
    }
    // Cubism 2 often exposes its live arrays only through the private model
    // context. `restoreNeutralModelPose` handles both public and private
    // layouts and, importantly, restores every concrete model in a composite.
    restoreNeutralModelPose(entry, entry.model);
  }

  private captureCustomMotionHandoff(
    entry: CharacterEntry,
    snapshot?: ModelSnapshot | null,
  ): CustomMotionHandoffPose {
    const values: Record<string, number> = {};
    const state = entry.customMotion;
    if (!state) return { values };
    const controls = getLive2DRuntimeAdapter(entry.runtime).getControls();
    const parameters = controls.getParameterValues(entry.model) ?? [];
    const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
    // Effect-channel parameters (an in-flight lip-sync mouth value) are
    // excluded so the transient effect output is not baked into the fade-in
    // source; uncovered ids fall back to the curve value at fade evaluation.
    const handoffValues = selectHandoffPoseValues(
      byName,
      state.controlledParameterIds,
      snapshot?.params,
      entry.lipSyncParameterIds,
    );
    const previous = this.seekHandoffs.get(entry);
    const parameterIds = Object.keys(handoffValues);
    if (previous && Object.keys(previous.values).length === parameterIds.length
      && parameterIds.every(id => previous.values[id] === handoffValues[id])) {
      return previous;
    }
    const handoff = { values: handoffValues };
    this.seekHandoffs.set(entry, handoff);
    return handoff;
  }

  resolveSceneTime(entry: CharacterEntry, manualTimeMs: number | undefined): number {
    if (manualTimeMs !== undefined && Number.isFinite(manualTimeMs)) {
      return manualTimeMs / 1000;
    }
    const scriptTime = this.getSceneTime();
    if (typeof scriptTime === 'number' && Number.isFinite(scriptTime)) {
      return scriptTime;
    }
    const lastManual = entry.lastManualTimeMs;
    return typeof lastManual === 'number' && Number.isFinite(lastManual) ? lastManual / 1000 : 0;
  }
}
