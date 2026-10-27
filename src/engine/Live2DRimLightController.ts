/** Owns rim-light commands, delayed entrance replay and absolute seek reconciliation. */
import * as PIXI from 'pixi.js';
import gsap from 'gsap';
import type { CharacterEntry } from './Live2DConfig';
import type { RimLightStyleState } from '../api/types/visual';
import type { PendingRimLightCommand } from './Live2DStageRuntime';
import { RimLightFilter } from './RimLightFilter';
import { resolveRimLightStateAtTime, type ResolvedRimLightState } from './RimLightResolver';
import type { RuntimeTimelineScene } from './RuntimeTimelineScene';

type RimLightOptions = Omit<RimLightStyleState, 'color'> & {
  color: string | number;
  duration: number;
};

export class Live2DRimLightController {
  constructor(
    private readonly characters: ReadonlyMap<string, CharacterEntry>,
    private readonly getContainer: (id: string) => PIXI.Container,
    private readonly getSceneTime: () => number | undefined,
    private readonly pendingRimLightCommands: Map<string, PendingRimLightCommand>,
    private readonly pendingRimLightStates: Map<string, ResolvedRimLightState>,
  ) {}

  private getElapsedSince(startTime?: number): number {
    if (startTime === undefined) return 0;
    const currentTime = this.getSceneTime();
    if (currentTime === undefined || !Number.isFinite(currentTime)) return 0;
    return Math.max(0, currentTime - startTime);
  }

  applyPending(id: string): void {
    const pendingRimCommand = this.pendingRimLightCommands.get(id);
    if (pendingRimCommand) {
      this.pendingRimLightCommands.delete(id);
      if (pendingRimCommand.mode === 'set') {
        this.applyRimLightSet(id, pendingRimCommand, this.getElapsedSince(pendingRimCommand.startTime));
      } else {
        this.applyRimLightReset(
          id,
          pendingRimCommand.duration,
          pendingRimCommand.baseline,
          this.getElapsedSince(pendingRimCommand.startTime),
        );
      }
      return;
    }

    const pendingRimState = this.pendingRimLightStates.get(id);
    if (pendingRimState) {
      this.applyResolvedRimLightState(id, pendingRimState);
    }
  }

  removeCharacter(id: string): void {
    this.pendingRimLightCommands.delete(id);
    const entry = this.characters.get(id);
    if (entry?.rimProxy) gsap.killTweensOf(entry.rimProxy);
    if (entry) {
      delete entry.rimProxy;
      delete entry.rimFilter;
    }
  }

  setRimLight(id: string, options: RimLightOptions, sceneTime?: number): void {
    const entry = this.characters.get(id);
    const commandTime = Number.isFinite(sceneTime)
      ? sceneTime
      : this.getSceneTime();
    const command: Extract<PendingRimLightCommand, { mode: 'set' }> = {
      mode: 'set',
      ...options,
      ...(Number.isFinite(commandTime) ? { startTime: commandTime } : {}),
    };
    if (!entry) {
      this.pendingRimLightCommands.set(id, command);
      this.pendingRimLightStates.delete(id);
      return;
    }

    this.pendingRimLightCommands.delete(id);
    this.pendingRimLightStates.delete(id);
    this.applyRimLightSet(id, command, this.getElapsedSince(command.startTime));
  }

  private applyRimLightSet(
    id: string,
    command: Extract<PendingRimLightCommand, { mode: 'set' }>,
    elapsed: number = 0,
  ): void {
    const entry = this.characters.get(id);
    if (!entry) return;

    const filter = this.ensureRimFilter(id, command.thickness, command.angle);
    if (!filter) return;

    this.configureRimFilter(filter, {
      color: command.color,
      thickness: command.thickness,
      angle: command.angle,
      softness: command.softness,
      alpha: entry.rimProxy?.alpha ?? 0,
    });

    const proxy = entry.rimProxy;
    if (!proxy) return;

    // Tween only highlight strength; the filter preserves the model alpha.
    gsap.killTweensOf(proxy);
    if ('enabled' in filter) filter.enabled = true;

    const applyAlpha = () => {
      filter.alpha = proxy.alpha;
      if ('enabled' in filter) filter.enabled = proxy.alpha > 0.05;
    };

    const duration = Math.max(0, command.duration);
    if (duration <= 0 || elapsed >= duration) {
      proxy.alpha = command.intensity;
      applyAlpha();
      return;
    }

    if (elapsed > 0) {
      const progress = gsap.parseEase('power2.inOut')(Math.min(1, elapsed / duration));
      proxy.alpha = command.intensity * progress;
      applyAlpha();
    }

    gsap.to(proxy, {
      alpha: command.intensity,
      duration: Math.max(0, duration - elapsed),
      ease: elapsed > 0 ? 'none' : 'power2.inOut',
      onUpdate: applyAlpha,
      onComplete: applyAlpha,
    });
  }

  /** Fade the current character rim light out without applying default style values. */
  resetRimLight(id: string, duration: number = 0.4, baseline?: RimLightStyleState, sceneTime?: number): void {
    const entry = this.characters.get(id);
    const commandTime = Number.isFinite(sceneTime)
      ? sceneTime
      : this.getSceneTime();
    const command: Extract<PendingRimLightCommand, { mode: 'reset' }> = {
      mode: 'reset',
      duration,
      ...(baseline ? { baseline } : {}),
      ...(Number.isFinite(commandTime) ? { startTime: commandTime } : {}),
    };
    if (!entry) {
      this.pendingRimLightCommands.set(id, command);
      this.pendingRimLightStates.delete(id);
      return;
    }

    this.pendingRimLightCommands.delete(id);
    this.pendingRimLightStates.delete(id);
    this.applyRimLightReset(id, duration, baseline, this.getElapsedSince(command.startTime));
  }

  private applyRimLightReset(id: string, duration: number, baseline?: RimLightStyleState, elapsed: number = 0): void {
    const entry = this.characters.get(id);
    if (!entry) return;

    let filter = entry.rimFilter;
    let proxy = entry.rimProxy;
    if ((!filter || !proxy) && baseline && baseline.intensity > 0) {
      filter = this.ensureRimFilter(id, baseline.thickness, baseline.angle) ?? undefined;
      proxy = entry.rimProxy;
    }
    if (!filter || !proxy) return;

    if (baseline) {
      this.configureRimFilter(filter, {
        ...baseline,
        alpha: proxy.alpha,
      });
    }
    const applyAlpha = () => {
      filter.alpha = proxy.alpha;
      if ('enabled' in filter) filter.enabled = proxy.alpha > 0.05;
    };

    gsap.killTweensOf(proxy);
    const targetAlpha = baseline?.intensity ?? 0;
    if (duration <= 0 || elapsed >= duration) {
      proxy.alpha = targetAlpha;
      applyAlpha();
      return;
    }

    if (elapsed > 0) {
      const progress = gsap.parseEase('power2.inOut')(Math.min(1, elapsed / duration));
      proxy.alpha += (targetAlpha - proxy.alpha) * progress;
      applyAlpha();
    }

    if (proxy.alpha > 0.05 && 'enabled' in filter) filter.enabled = true;
    gsap.to(proxy, {
      alpha: targetAlpha,
      duration: Math.max(0, duration - elapsed),
      ease: elapsed > 0 ? 'none' : 'power2.inOut',
      onUpdate: applyAlpha,
      onComplete: applyAlpha,
    });
  }

  /**
   * Reconcile character rim lights for absolute seek/scrubbing compatibility.
   */
  reconcileRimLights(time: number, scene: RuntimeTimelineScene): void {
    this.pendingRimLightCommands.clear();
    this.pendingRimLightStates.clear();
    for (const id of this.characters.keys()) {
      this.clearRimLight(id);
    }

    const rimStates = resolveRimLightStateAtTime(scene, time);
    for (const [id, state] of rimStates) {
      this.pendingRimLightStates.set(id, state);
      this.applyResolvedRimLightState(id, state);
    }
  }

  private applyResolvedRimLightState(id: string, state: ResolvedRimLightState): void {
    const filter = this.ensureRimFilter(id, state.thickness, state.angle);
    if (!filter) return;

    this.configureRimFilter(filter, state);
    const entry = this.characters.get(id);
    const proxy = entry?.rimProxy;
    if (!proxy) return;

    gsap.killTweensOf(proxy);
    proxy.alpha = state.alpha;
    filter.alpha = state.alpha;
    if ('enabled' in filter) filter.enabled = state.alpha > 0.05;
  }

  private ensureRimFilter(id: string, thickness: number, angle: number): RimLightFilter | null {
    const entry = this.characters.get(id);
    if (!entry) return null;
    const container = this.getContainer(id);

    let filter = entry.rimFilter;
    if (!filter) {
      filter = new RimLightFilter({
        distance: thickness,
        rotation: angle,
        blur: 0,
        alpha: 0,
        color: 0xFFFFFF,
      });
      entry.rimFilter = filter;
      entry.rimProxy = { alpha: 0 };

      const currentFilters = container.filters || [];
      // Entrance opacity must be applied after lighting, so the contour mask
      // stays at model opacity throughout the fade (including queued lights).
      const opacityIndex = currentFilters.findIndex((current) => current instanceof PIXI.AlphaFilter);
      const insertIndex = opacityIndex < 0 ? currentFilters.length : opacityIndex;
      container.filters = [
        ...currentFilters.slice(0, insertIndex),
        filter,
        ...currentFilters.slice(insertIndex),
      ];
    }
    return filter;
  }

  private configureRimFilter(filter: RimLightFilter, state: {
    color: string | number;
    thickness: number;
    angle: number;
    softness: number;
    alpha: number;
  }): void {
    filter.color = typeof state.color === 'string'
      ? parseInt((state.color || '#ffffff').replace('#', '0x'))
      : state.color;
    filter.distance = state.thickness;
    filter.rotation = state.angle;
    filter.blur = state.softness;
    filter.alpha = state.alpha;
    if ('enabled' in filter) filter.enabled = state.alpha > 0.05;
  }

  private clearRimLight(id: string): void {
    const entry = this.characters.get(id);
    if (!entry) return;
    const filter = entry.rimFilter;
    const proxy = entry.rimProxy;
    if (proxy) gsap.killTweensOf(proxy);
    if (filter) {
      filter.alpha = 0;
      if ('enabled' in filter) filter.enabled = false;
      if (proxy) {
        proxy.alpha = 0;
      }
    }
  }
}
