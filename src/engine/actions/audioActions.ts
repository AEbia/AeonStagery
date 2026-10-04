import type { SchedulerContext } from './types';
import {
  configureAudioElement,
  isAudioElementDisposed,
  markAudioElementDisposed,
  markAudioElementStop,
} from '../coordinators/AudioCoordinator';

let generatedAudioKey = 0;

export function schedulePlayAudio(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { resolvePath, resolvePathAsync, audioElements } = ctx;
  const { time, params } = action;
  const t = finiteNumber(time) ?? 0;
  const file = normalizeAudioFile(params.file);
  if (!file) return;

  const key = resolveAudioKey(params.id, t);
  const loop = params.loop === true;
  const duration = finiteNumber(params.duration) ?? (loop ? Number.POSITIVE_INFINITY : 10);
  const volume = nonNegativeNumber(params.volume) ? params.volume : 1;
  const fadeIn = nonNegativeNumber(params.fadeIn) ? params.fadeIn : 0;
  const fadeOut = nonNegativeNumber(params.fadeOut) ? params.fadeOut : undefined;
  const audio = createScheduledAudio(
    file,
    resolvePath,
    resolvePathAsync,
    volume,
    loop,
    fadeIn,
    fadeOut,
  );
  if (!audio) return;

  audioElements.set(key, {
    audio,
    startTime: t,
    duration,
  });
}

export function scheduleStopAudio(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl, isReconstructing, audioElements } = ctx;
  const { time, params } = action;
  const t = finiteNumber(time) ?? 0;
  const id = typeof params.id === 'string' ? params.id : '';
  if (!id) return;

  const fadeOut = nonNegativeNumber(params.fadeOut) ? params.fadeOut : undefined;
  const scheduled = audioElements.get(id);
  if (scheduled) markAudioElementStop(scheduled.audio, t, fadeOut);

  // The coordinator owns the actual pause/removal so that a seek directly
  // into the fade interval reconstructs the same state as forward playback.
  atTimelineTime(tl, t, () => {
    if (isReconstructing()) return;
    scheduled?.audio.pause();
  });
}

export function scheduleSetBGM(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { resolvePath, resolvePathAsync, audioElements } = ctx;
  const { time, params } = action;
  const t = finiteNumber(time) ?? 0;
  const file = normalizeAudioFile(params.file);
  const previous = audioElements.get('bgm');
  const fadeOut = nonNegativeNumber(params.fadeOut) ? params.fadeOut : undefined;

  if (!file) {
    if (previous) {
      markAudioElementStop(previous.audio, t, fadeOut);
    }
    return;
  }

  if (previous) markAudioElementStop(previous.audio, t, fadeOut);

  // BGM keeps the historical preview defaults. Export consumes the same
  // defaults when it materializes a timeline interval.
  const volume = nonNegativeNumber(params.volume) ? params.volume : 0.5;
  const fadeIn = nonNegativeNumber(params.fadeIn) ? params.fadeIn : 2;
  const loop = params.loop !== false;
  const audio = createScheduledAudio(
    file,
    resolvePath,
    resolvePathAsync,
    volume,
    loop,
    fadeIn,
    fadeOut,
  );
  if (!audio) return;

  audioElements.set('bgm', {
    audio,
    startTime: t,
    duration: Number.POSITIVE_INFINITY,
  });
}

function createScheduledAudio(
  file: string,
  resolvePath: (path: string) => string,
  resolvePathAsync: ((path: string) => Promise<string>) | undefined,
  volume: number,
  loop: boolean,
  fadeIn: number,
  fadeOut: number | undefined,
): HTMLAudioElement | null {
  let initialSource: string | undefined;
  if (!resolvePathAsync) {
    try {
      initialSource = resolvePath(file);
      if (!initialSource || !initialSource.trim()) {
        throw new Error('Audio path resolver returned an empty path');
      }
    } catch (error) {
      console.error(`[Audio] Failed to resolve audio asset "${file}":`, error);
      return null;
    }
  }

  let audio: HTMLAudioElement;
  try {
    audio = initialSource === undefined ? new Audio() : new Audio(initialSource);
  } catch (error) {
    console.error(`[Audio] Failed to create audio element for "${file}":`, error);
    return null;
  }
  audio.loop = loop;
  audio.volume = fadeIn > 0 ? 0 : volume;
  configureAudioElement(audio, { volume, fadeIn, ...(fadeOut !== undefined ? { fadeOut } : {}), loop });
  const reportLoadFailure = (): void => {
    markAudioElementDisposed(audio);
    console.error(`[Audio] Failed to load audio asset "${file}" from "${audio.src}"`);
  };
  if (typeof (audio as any).addEventListener === 'function') {
    audio.addEventListener('error', reportLoadFailure, { once: true });
  } else {
    (audio as any).onerror = reportLoadFailure;
  }

  if (resolvePathAsync) {
    void resolvePathAsync(file)
      .then((resolvedPath) => {
        if (!resolvedPath || !resolvedPath.trim()) {
          throw new Error('Audio path resolver returned an empty path');
        }
        if (!isAudioElementDisposed(audio)) audio.src = resolvedPath;
      })
      .catch((error) => {
        markAudioElementDisposed(audio);
        console.error(`[Audio] Failed to resolve audio asset "${file}":`, error);
      });
  }

  return audio;
}

function atTimelineTime(tl: SchedulerContext['tl'], time: number, callback: () => void): void {
  tl.to({}, {
    duration: 0.001,
    onStart: callback,
  }, time);
}

function resolveAudioKey(value: unknown, time: number): string {
  if (typeof value === 'string' && value.trim()) return value;
  generatedAudioKey += 1;
  return `audio-${time}-${generatedAudioKey}`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeAudioFile(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
