/**
 * AeonStagery — PreBake Daemon
 *
 * Smart background snapshot pre-baking scheduler.
 * Monitors the user's edit position and automatically bakes snapshots
 * in a priority-tiered fashion:
 *
 *   HOT  zone: editTime ± hotRadius   @ hotPrecision   (highest priority)
 *   WARM zone: editTime ± warmRadius  @ warmPrecision
 *   COLD zone: 0 .. totalDuration     @ coldPrecision   (lowest priority, gap fill)
 *
 * CRITICAL CONSTRAINT: ALL baking is suspended during playback to avoid
 * interfering with the main rendering thread.
 */

import { BakeEngine } from '../BakeEngine';
import { SnapshotStore } from '../SnapshotStore';
import { WmdlConfigRegistry } from '../WmdlConfigRegistry';
import { stageManager } from '../StageManager';
import { eventBus } from '../../api/events';
import { settingsManager } from '../../ui/SettingsStore';
import { getLogger } from '../Logger';
import type { PreparedCompiledScene } from '../../api/types/semantic-scene';

// ── Types ─────────────────────────────────────────────────────────────────

interface BakeTask {
  priority: 'hot' | 'warm' | 'cold';
  rangeStart: number;
  rangeEnd: number;
  precision: number;
}

type DaemonState = 'idle' | 'baking' | 'suspended' | 'detached' | 'disposed';

// ── PreBakeDaemon ─────────────────────────────────────────────────────────

export class PreBakeDaemon {
  private logger = getLogger('PreBakeDaemon');
  private state: DaemonState = 'idle';
  private wmdlConfigRegistry: WmdlConfigRegistry | null = null;

  public setWmdlConfigRegistry(registry: WmdlConfigRegistry): void {
    this.wmdlConfigRegistry = registry;
  }

  // External dependencies (injected via attach)
  private snapshotStore: SnapshotStore | null = null;
  private currentScene: PreparedCompiledScene | null = null;
  private resolvedModelPaths: Map<string, string> = new Map();

  // Scheduling
  private editPosition: number = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private taskQueue: BakeTask[] = [];
  private currentBakeEngine: BakeEngine | null = null;
  private bakeToken: number = 0;
  private isPlaying: boolean = false;
  private isSeeking: boolean = false;
  private processPromise: Promise<void> | null = null;

  // Event unsubscribers
  private unsubs: (() => void)[] = [];

  // ── Lifecycle ───────────────────────────────────────────────────────

  attach(
    snapshotStore: SnapshotStore,
    scene: PreparedCompiledScene,
  ): void {
    // 核心修复：切勿在此处调用 this.dispose() 销毁 BakeEngine！
    // 用户每次编辑时间轴都会触发 ScriptEngine.loadPreparedScene，从而调用 attach。
    // 如果每次都销毁 BakeEngine，会导致底层的 pixi-live2d-display 反复创建和销毁 Live2DModel，
    // 由于底层 C++ (Oilpan/WebGL) 回收机制的限制，极易引发 CppHeap 的 4GB 巨大内存泄漏！
    
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.debounceTimer = null;
    this.resumeTimer = null;

    if (this.currentBakeEngine) {
      this.currentBakeEngine.cancel();
      // KEEP ALIVE!
    }

    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];

    this.snapshotStore = snapshotStore;
    this.currentScene = scene;
    this.state = 'idle';
    this.isPlaying = false;
    this.isSeeking = false;
    this.taskQueue = [];
    this.bakeToken++;

    // Prepared action asset refs already carry runtimeUri. BakeEngine builds
    // the source/runtime lookup from those refs at the prepared runtime seam.
    this.resolvedModelPaths.clear();

    // Listen for engine events
    this.unsubs.push(
      eventBus.on('scene:play', () => {
        this.isPlaying = true;
        this.isSeeking = false;
        this.suspend();
      }),
      eventBus.on('scene:pause', () => {
        this.isPlaying = false;
        if (this.isSeeking) {
          this.suspend();
          return;
        }
        this.debouncedResume();
      }),
      eventBus.on('scene:end', () => {
        this.isPlaying = false;
        if (this.isSeeking) return;
        this.debouncedResume();
      }),
      eventBus.on('scene:seek:start', () => {
        this.isSeeking = true;
        this.suspend();
      }),
      eventBus.on('scene:seek:end', () => {
        this.isSeeking = false;
        if (!this.isPlaying) {
          this.debouncedResume();
        }
      }),
    );

    this.logger.info('Attached to scene, preserved BakeEngine to prevent CppHeap leak.');
  }

  /**
   * Notify the daemon that the user's edit position has changed.
   * This is the primary input that drives priority scheduling.
   */
  notifyEditPosition(time: number): void {
    if (!settingsManager.get('preBakeEnabled')) return;
    if (this.state === 'disposed') return;

    this.editPosition = time;
    if (this.isSeeking) {
      this.isSeeking = false;
    }

    // 核心修复：当用户拖拽时间轴或点击时，立即取消正在后台执行的烘焙任务！
    // 否则后台 BakeEngine 会疯狂占用 CPU 和 全局锁，导致前台严重卡顿甚至崩溃。
    if (this.currentBakeEngine) {
      this.currentBakeEngine.cancel();
    }
    this.bakeToken++; // 使得正在执行的 while 循环立即 break
    this.state = 'suspended'; // 在防抖期间标记为挂起

    // Debounce: wait for the user to stop scrubbing before scheduling
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const debounceMs = settingsManager.get('preBakeDebounce');
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.state = 'idle'; // 恢复为空闲状态，允许开始调度
      this.scheduleFromEditPosition();
    }, debounceMs);
  }

  /**
   * Force an immediate full-scene cold scan (e.g. after initial scene load).
   */
  triggerColdScan(): void {
    if (!settingsManager.get('preBakeEnabled')) return;
    if (this.state === 'disposed' || !this.currentScene) return;

    // Cancel running background tasks to prevent locking the main thread
    if (this.currentBakeEngine) {
      this.currentBakeEngine.cancel();
    }
    this.bakeToken++;
    this.state = 'suspended';

    // Debounce cold scan for 1s to prevent spam during rapid edits
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const debounceMs = settingsManager.get('preBakeDebounce') || 1000;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.state = 'idle';

      const totalDuration = this.getSceneDuration();
      const coldPrecision = settingsManager.get('preBakeColdPrecision') || 2;

      this.taskQueue.push({
        priority: 'cold',
        rangeStart: 0,
        rangeEnd: totalDuration,
        precision: coldPrecision,
      });

      this.ensureProcessing();
    }, debounceMs);
  }

  /**
   * Suspend all baking. Called when playback starts.
   */
  private suspend(): void {
    if (this.state === 'disposed') return;

    // Cancel any pending debounced resume — prevents the pause→play race
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }

    this.logger.info('Suspended — playback active.');

    // 核心修复：仅取消任务，切勿销毁 BakeEngine，否则底层 Live2DModel 会被销毁，导致 CppHeap 发生泄漏
    if (this.currentBakeEngine) {
      this.currentBakeEngine.cancel();
      // DO NOT DESTROY
    }
    this.bakeToken++;
    this.taskQueue = [];

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.state = 'suspended';
  }

  /**
   * Debounced resume: wait 300ms before actually starting baking.
   * If scene:play fires within this window (e.g. during seek→play),
   * suspend() cancels the timer and baking never starts.
   */
  private debouncedResume(): void {
    if (this.state === 'disposed') return;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.resume();
    }, 300);
  }

  /**
   * Resume baking. Only called via debouncedResume() to prevent race conditions.
   */
  private resume(): void {
    if (this.state === 'disposed') return;
    if (this.isPlaying) return; // Double-check

    this.state = 'idle';
    this.logger.info('Resumed — scheduling from current position.');
    this.scheduleFromEditPosition();
  }

  /**
   * Non-destructive separation used by soft scene reloads: cancels timers and
   * any in-flight baking and unsubscribes daemon listeners, but KEEPS the
   * BakeEngine alive and re-usable. Destroying and re-creating the BakeEngine
   * on every commit churns the underlying Live2DModel CppHeap (see attach()).
   */
  detach(): void {
    if (this.state === 'disposed') return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }

    if (this.currentBakeEngine) {
      this.currentBakeEngine.cancel();
      // KEEP ALIVE!
    }

    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];

    this.bakeToken++;
    this.taskQueue = [];
    this.snapshotStore = null;
    this.currentScene = null;
    this.state = 'detached';
  }

  /**
   * Fully dispose the daemon and release all resources.
   */
  dispose(): void {
    this.state = 'disposed';

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }

    if (this.currentBakeEngine) {
      this.currentBakeEngine.cancel();
      this.currentBakeEngine.destroy();
      this.currentBakeEngine = null;
    }

    this.bakeToken++;
    this.taskQueue = [];
    this.snapshotStore = null;
    this.currentScene = null;

    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  // ── Scheduling ────────────────────────────────────────────────────────

  private scheduleFromEditPosition(): void {
    if (this.state === 'disposed' || this.state === 'suspended') return;
    if (this.isPlaying) return;
    if (!this.currentScene || !this.snapshotStore) return;

    const totalDuration = this.getSceneDuration();
    const hotRadius = settingsManager.get('preBakeHotRadius');
    const warmRadius = settingsManager.get('preBakeWarmRadius');
    const hotPrecision = settingsManager.get('preBakeHotPrecision');
    const warmPrecision = settingsManager.get('preBakeWarmPrecision');
    const coldPrecision = settingsManager.get('preBakeColdPrecision');

    const editTime = this.editPosition;

    // Clear existing queue — re-plan from scratch based on current position
    this.taskQueue = [];

    // 1. HOT zone: editTime ± hotRadius
    const hotStart = Math.max(0, editTime - hotRadius);
    const hotEnd = Math.min(totalDuration, editTime + hotRadius);
    const hotGaps = this.snapshotStore.getGaps(hotStart, hotEnd, hotPrecision * 1.5);
    for (const gap of hotGaps) {
      this.taskQueue.push({
        priority: 'hot',
        rangeStart: gap.from,
        rangeEnd: gap.to,
        precision: hotPrecision,
      });
    }

    // 2. WARM zone: editTime ± warmRadius (excluding hot zone)
    const warmStart = Math.max(0, editTime - warmRadius);
    const warmEnd = Math.min(totalDuration, editTime + warmRadius);
    // Before hot zone
    if (warmStart < hotStart) {
      const gaps = this.snapshotStore.getGaps(warmStart, hotStart, warmPrecision * 1.5);
      for (const gap of gaps) {
        this.taskQueue.push({ priority: 'warm', rangeStart: gap.from, rangeEnd: gap.to, precision: warmPrecision });
      }
    }
    // After hot zone
    if (warmEnd > hotEnd) {
      const gaps = this.snapshotStore.getGaps(hotEnd, warmEnd, warmPrecision * 1.5);
      for (const gap of gaps) {
        this.taskQueue.push({ priority: 'warm', rangeStart: gap.from, rangeEnd: gap.to, precision: warmPrecision });
      }
    }

    // 3. COLD zone: rest of timeline (excluding warm zone)
    if (warmStart > 0) {
      const gaps = this.snapshotStore.getGaps(0, warmStart, coldPrecision * 1.5);
      for (const gap of gaps) {
        this.taskQueue.push({ priority: 'cold', rangeStart: gap.from, rangeEnd: gap.to, precision: coldPrecision });
      }
    }
    if (warmEnd < totalDuration) {
      const gaps = this.snapshotStore.getGaps(warmEnd, totalDuration, coldPrecision * 1.5);
      for (const gap of gaps) {
        this.taskQueue.push({ priority: 'cold', rangeStart: gap.from, rangeEnd: gap.to, precision: coldPrecision });
      }
    }

    // Sort: hot first, then warm, then cold
    const priorityOrder = { hot: 0, warm: 1, cold: 2 };
    this.taskQueue.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    if (this.taskQueue.length > 0) {
      this.logger.info(
        `Scheduled ${this.taskQueue.length} tasks (hot=${hotGaps.length} gaps) around t=${editTime.toFixed(1)}s`
      );
      this.ensureProcessing();
    } else {
      this.logger.info(`No gaps to fill around t=${editTime.toFixed(1)}s`);
    }
  }

  // ── Task Execution ────────────────────────────────────────────────────

  private ensureProcessing(): void {
    if (this.processPromise) return;
    this.processPromise = this.processQueue().finally(() => {
      this.processPromise = null;
      if (
        this.state === 'idle' &&
        !this.isPlaying &&
        this.taskQueue.length > 0 &&
        this.currentScene &&
        this.snapshotStore
      ) {
        this.ensureProcessing();
      }
    });
  }

  private async processQueue(): Promise<void> {
    if (this.state !== 'idle' || this.isPlaying) return;
    if (this.taskQueue.length === 0) return;
    if (!this.currentScene || !this.snapshotStore) return;

    this.state = 'baking';
    const token = ++this.bakeToken;

    while (this.taskQueue.length > 0 && this.bakeToken === token && !this.isPlaying) {
      const task = this.taskQueue.shift()!;

      // Skip tiny ranges
      if (task.rangeEnd - task.rangeStart < task.precision) continue;

      this.logger.info(
        `Baking [${task.priority}] ${task.rangeStart.toFixed(1)}s → ${task.rangeEnd.toFixed(1)}s @ ${task.precision}s`
      );

      try {
        // Find seed snapshot for jump-start
        const seedSnapshot = this.snapshotStore.findBefore(task.rangeStart);

        const app = stageManager.getApp();
        if (!this.currentBakeEngine) {
          this.currentBakeEngine = new BakeEngine(app, this.wmdlConfigRegistry!);
        }
        const bakeEngine = this.currentBakeEngine;

        const result = await bakeEngine.bakePreparedRange(
          this.currentScene,
          this.resolvedModelPaths,
          token,
          task.rangeStart,
          task.rangeEnd,
          task.precision,
          seedSnapshot ?? undefined,
          true, // silent = true for background daemon pre-baking
        );

        // We DO NOT destroy the engine here to reuse models across tasks.
        // It will be disposed only when playback starts (suspend) or scene changes (dispose).

        // Check if cancelled
        if (this.bakeToken !== token || this.isPlaying) {
          this.logger.info('Bake cancelled during task.');
          break;
        }

        // Merge results into the shared SnapshotStore
        if (result.snapshotHistory.length > 0) {
          this.snapshotStore.mergeFrom(result.snapshotHistory);
          this.logger.info(
            `Merged ${result.snapshotHistory.length} snapshots. Store: ${this.snapshotStore.size} total.`
          );
        }
      } catch (err) {
        this.logger.error('Bake task failed:', err);
        if (this.currentBakeEngine) {
          this.currentBakeEngine.cancel();
          this.currentBakeEngine.destroy();
          this.currentBakeEngine = null;
        }
        // Continue with next task
      }

      // Yield to main thread between tasks to keep UI responsive
      if (this.taskQueue.length > 0) {
        await new Promise(r => setTimeout(r, 10));
        if (this.isPlaying || this.bakeToken !== token) break;
      }
    }

    if (this.bakeToken === token && this.state === 'baking') {
      this.state = 'idle';
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private getSceneDuration(): number {
    if (!this.currentScene) return 0;
    return this.currentScene.durationSeconds;
  }
}

export const preBakeDaemon = new PreBakeDaemon();
