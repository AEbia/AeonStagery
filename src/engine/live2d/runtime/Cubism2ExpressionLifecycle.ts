import {
  getSharedRuntimeClockForTransaction,
  withSharedRuntimeClock,
  type Live2DClockTransaction,
  type Live2DRuntimeClock,
} from './Live2DRuntimeClockCoordinator';

/** Private SDK shapes: callers only pass a model and an Expression intent. */
interface ExpressionQueue {
  stopAllMotions?(): void;
  _motions?: unknown[];
}

interface ExpressionManager {
  destroyed?: boolean;
  expressions?: unknown[];
  definitions?: Array<{ name?: string }>;
  defaultExpression?: unknown;
  currentExpression?: unknown;
  reserveExpressionIndex?: number;
  _currentExpression?: unknown;
  activeExpression?: unknown;
  _motions?: unknown[];
  motions?: unknown[];
  state?: { currentGroup?: string; reservedGroup?: string };
  queueManager?: ExpressionQueue;
  _motionQueueManager?: ExpressionQueue;
  getExpressionIndex?(name: string): number;
  loadExpression?(index: number): Promise<unknown>;
  restoreExpression?(): void;
  stopAllExpressions?(): void;
  _setExpression?(expression: unknown): unknown;
  update?(coreModel: unknown, timeMs: number): unknown;
}

interface ExpressionTarget {
  destroyed?: boolean;
  expression?(name: string): unknown;
  update?(deltaMs: number): void;
  internalModel?: {
    coreModel?: object;
    motionManager?: { expressionManager?: ExpressionManager };
  };
}

/**
 * Owns Cubism 2 Expression requests, queue cleanup and Seek fade reconstruction.
 * Every exit invalidates pending requests before a model can be borrowed again.
 * Shared clock transactions and SDK shapes remain inside the runtime.
 */
export class Cubism2ExpressionLifecycle {
  private readonly expressionRequestEpochs = new WeakMap<object, number>();

  constructor(
    private readonly concreteModels: (model: unknown) => readonly ExpressionTarget[],
    private readonly clockProvider: () => Live2DRuntimeClock | null,
  ) {}

  set(model: unknown, expressionName: string | null): void {
    if (!expressionName) {
      this.clear(model);
      return;
    }
    for (const target of this.concreteModels(model)) {
      const manager = target.internalModel?.motionManager?.expressionManager;
      if (target.destroyed || manager?.destroyed) continue;
      const epoch = manager ? this.supersedeExpressionRequest(manager) : 0;
      const index = manager?.getExpressionIndex?.(expressionName) ?? -1;
      const currentIndex = manager?.expressions?.indexOf(manager.currentExpression) ?? -1;

      // Motion startup may have queued default over the still-current named
      // Expression. Restore it synchronously instead of loading it again.
      if (manager && index >= 0 && index === currentIndex && manager.restoreExpression) {
        manager.reserveExpressionIndex = -1;
        manager.restoreExpression();
      } else if (manager && index >= 0 && manager.loadExpression && manager._setExpression) {
        manager.reserveExpressionIndex = index;
        void this.loadForPlayback(target, manager, index, epoch);
      } else {
        // Preserve compatibility with models exposing only the SDK delegation.
        // The installed Cubism 2 manager uses the owned load path above.
        const pending = target.expression?.(expressionName);
        if (pending && typeof (pending as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(pending).catch(() => { /* teardown abort */ });
        }
      }
    }
  }

  clear(model: unknown): void {
    for (const target of this.concreteModels(model)) {
      const manager = target.internalModel?.motionManager?.expressionManager;
      if (!manager) continue;
      this.supersedeExpressionRequest(manager);
      if (target.destroyed || manager.destroyed) continue;
      this.stopQueues(manager);
      manager.currentExpression = manager.defaultExpression ?? null;
      manager._currentExpression = null;
      manager.activeExpression = null;
      if (manager._motions) manager._motions = [];
      if (manager.motions) manager.motions = [];
      if (manager.state) {
        manager.state.currentGroup = undefined;
        manager.state.reservedGroup = undefined;
      }
      if (manager._motionQueueManager?._motions) manager._motionQueueManager._motions = [];
    }
  }

  private async loadForPlayback(
    target: ExpressionTarget, manager: ExpressionManager, index: number, epoch: number,
  ): Promise<void> {
    try {
      const expression = await manager.loadExpression!(index);
      if (!this.isCurrentTarget(target, manager, epoch)) return;
      if (!expression || manager.reserveExpressionIndex !== index) return;
      manager.reserveExpressionIndex = -1;
      manager.currentExpression = expression;
      manager._setExpression!(expression);
    } catch {
      // The SDK can reject after destroy() removes its expression caches.
    } finally {
      if (this.isCurrentTarget(target, manager, epoch)) manager.reserveExpressionIndex = -1;
    }
  }

  private supersedeExpressionRequest(expressionManager: object): number {
    const epoch = (this.expressionRequestEpochs.get(expressionManager) ?? 0) + 1;
    this.expressionRequestEpochs.set(expressionManager, epoch);
    return epoch;
  }

  private isCurrentExpressionRequest(expressionManager: object, epoch: number): boolean {
    return this.expressionRequestEpochs.get(expressionManager) === epoch;
  }

  private isCurrentTarget(
    target: ExpressionTarget, manager: ExpressionManager, epoch: number,
    isCurrent: () => boolean = () => true,
  ): boolean {
    return isCurrent() && !target.destroyed && !manager.destroyed
      && target.internalModel?.motionManager?.expressionManager === manager
      && this.isCurrentExpressionRequest(manager, epoch);
  }

  private stopQueues(manager: ExpressionManager): void {
    // SDK resetExpression() enqueues default, so it cannot quiesce a model.
    manager.reserveExpressionIndex = -1;
    manager.stopAllExpressions?.();
    manager.queueManager?.stopAllMotions?.();
    manager._motionQueueManager?.stopAllMotions?.();
  }

  async restoreForSeek(
    model: unknown,
    expressionName: string | null,
    elapsedSeconds: number,
    /**
     * Expression that was in effect immediately before the target's start time.
     * `null` means "none" (the seek target has no predecessor in the scene);
     * `undefined` means "unknown" and falls back to the model's live entry.
     */
    previousExpressionKey?: string | null,
    isCurrent: () => boolean = () => true,
    transaction?: Live2DClockTransaction,
  ): Promise<void> {
    const prepared = await Promise.all(this.concreteModels(model).map(async (target) => {
      if (!isCurrent()) return null;
      const internalModel = target?.internalModel;
      const coreModel = internalModel?.coreModel;
      const expressionManager = internalModel?.motionManager?.expressionManager;
      if (!coreModel || target?.destroyed || expressionManager?.destroyed) return null;
      if (!expressionManager) {
        // Models without expressions still need the restored pose committed
        // to their drawable geometry. v8 skips internalModel.update when the
        // accumulated delta is zero. Use the same minimal deferred flush as
        // the expression path below, inside the vendor's guarded render pass.
        target.update?.(0.001);
        return null;
      }
      const requestEpoch = this.supersedeExpressionRequest(expressionManager);

      this.stopQueues(expressionManager);

      if (!expressionName) {
        if (expressionManager.defaultExpression) {
          expressionManager.currentExpression = expressionManager.defaultExpression;
        }
        return { target, expressionManager, expression: null, previousExpression: null, previousKnown: true, requestEpoch };
      }

      const index = expressionManager.getExpressionIndex?.(expressionName) ?? -1;
      if (index < 0 || typeof expressionManager.loadExpression !== 'function') {
        if (expressionManager.defaultExpression) {
          expressionManager.currentExpression = expressionManager.defaultExpression;
        }
        return { target, expressionManager, expression: null, requestEpoch };
      }

      let expression: unknown;
      try {
        expression = await expressionManager.loadExpression(index);
      } catch {
        // Teardown aborted the load (destroy() cancels the in-flight XHR and
        // nulls the manager's caches, so the SDK's own continuation can also
        // fail). The seek target is moot — drop it like the superseded
        // request path below.
        return null;
      }
      if (!this.isCurrentTarget(target, expressionManager, requestEpoch, isCurrent)) return null;
      // A fire-and-forget expression request issued by motion restoration may
      // have shared this load. Invalidate its reservation again after await so
      // it cannot enqueue an older expression after this seek target.
      this.stopQueues(expressionManager);
      if (!expression && expressionManager.defaultExpression) {
        expressionManager.currentExpression = expressionManager.defaultExpression;
      }
      // Resolve the predecessor the seeked frame must blend out of. Taking the
      // model's live `currentExpression` reads whatever the previous playback
      // position left behind — including an expression that only exists later
      // in the scene — which is exactly the stale data a seek must not reuse.
      const previousKnown = previousExpressionKey !== undefined;
      let previousExpression: unknown = null;
      if (previousKnown && previousExpressionKey && previousExpressionKey !== expressionName) {
        const previousIndex = expressionManager.getExpressionIndex?.(previousExpressionKey) ?? -1;
        if (previousIndex >= 0) {
          try {
            previousExpression = await expressionManager.loadExpression(previousIndex);
          } catch {
            previousExpression = null;
          }
          if (!this.isCurrentTarget(target, expressionManager, requestEpoch, isCurrent)) return null;
          // Re-clear any SDK request sharing the predecessor's load.
          this.stopQueues(expressionManager);
        }
      }
      return {
        target,
        expressionManager,
        expression: expression ?? null,
        previousExpression,
        previousKnown,
        requestEpoch,
      };
    }));

    const targets = prepared.filter((target): target is NonNullable<typeof target> => !!target);
    if (targets.length === 0) return;

    await withSharedRuntimeClock(this.clockProvider(), isCurrent, async (lease) => {
      if (!isCurrent()) return;
      const currentTargets = targets.filter(({ target, expressionManager, requestEpoch }) =>
        this.isCurrentTarget(target, expressionManager, requestEpoch, isCurrent));
      if (currentTargets.length === 0) return;

      const utSystem = getSharedRuntimeClockForTransaction(lease);
      const nowMs = utSystem?.getUserTimeMSec() ?? performance.now();
      const elapsedMs = Number.isFinite(elapsedSeconds)
        ? Math.max(0, elapsedSeconds) * 1000
        : 24 * 60 * 60 * 1000;
      try {
        const hasExpression = currentTargets.some((target) => !!target.expression);

        if (utSystem && hasExpression) {
          // Playback keeps the previous expression in the queue (pixi's
          // _setExpression never stops the old entry), so switching from A to
          // B blends A's exclusive parameters out only where B owns them, and
          // the seeked frame matches the playback frame exactly. The seek
          // reconstruction re-creates that same queue shape with two clock
          // phases: the previous expression's entry starts far enough in the
          // past to be fully faded in (weight 1, resident writer), while the
          // target expression starts at the seeked elapsed so its fade weight
          // reconstructs in-window and continues from that progress.
          const PREVIOUS_EXPRESSION_AGE_MS = 6000;
          for (const target of currentTargets) {
            if (!this.isCurrentTarget(target.target, target.expressionManager, target.requestEpoch, isCurrent)) continue;
            if (!target.expression) continue;
            // `previousKnown` means the caller resolved the predecessor from
            // the scene: never fall back to the model's live entry, whose
            // `currentExpression` belongs to whatever position playback or the
            // previous seek left behind.
            const previous = target.previousKnown
              ? (target.previousExpression ?? null)
              : target.expressionManager.currentExpression;
            const previousIndex = Array.isArray(target.expressionManager.expressions)
              ? target.expressionManager.expressions.indexOf(previous)
              : -1;
            const previousIsLoadedExpression = !!previous
              && previous !== target.expression
              && (previousIndex >= 0
                ? target.expressionManager.definitions?.[previousIndex]?.name !== undefined
                // A runtime that does not cache loaded expressions in
                // `expressions` still produced the object we asked for.
                : previous === target.previousExpression);
            if (previousIsLoadedExpression) {
              // Phase 1: latch the previous expression's entry at a clock that
              // has its fade-in long completed, then evaluate it so the core
              // records that start time (weight becomes 1, it stays resident).
              utSystem.setUserTimeMSec(nowMs - elapsedMs - PREVIOUS_EXPRESSION_AGE_MS);
              target.expressionManager._setExpression?.(previous);
              target.expressionManager.update?.(
                target.target?.internalModel?.coreModel,
                nowMs - elapsedMs - PREVIOUS_EXPRESSION_AGE_MS,
              );
            }
            // Phase 2: latch the target expression at the seeked elapsed and
            // evaluate it so the seeked frame shows its in-progress fade.
            if (!this.isCurrentTarget(target.target, target.expressionManager, target.requestEpoch, isCurrent)) continue;
            utSystem.setUserTimeMSec(nowMs - elapsedMs);
            target.expressionManager.currentExpression = target.expression;
            target.expressionManager._setExpression?.(target.expression);
            target.expressionManager.update?.(
              target.target?.internalModel?.coreModel,
              nowMs - elapsedMs,
            );
          }
        }
      } finally {
        if (utSystem) {
          const currentTimeMs = utSystem.getUserTimeMSec();
          utSystem.setUserTimeMSec(Number.isFinite(currentTimeMs) ? Math.max(currentTimeMs, nowMs) : nowMs);
        }
      }

      // Live2DModel.update() only accumulates delta. The SDK performs the
      // actual motion/expression/core update inside its native _render(),
      // where Cubism's WebGL state is isolated from Pixi's filter programs.
      for (const prepared of currentTargets) {
        if (!this.isCurrentTarget(prepared.target, prepared.expressionManager, prepared.requestEpoch, isCurrent)) continue;
        prepared.target.update?.(0.001);
      }
    }, transaction);
  }
}
