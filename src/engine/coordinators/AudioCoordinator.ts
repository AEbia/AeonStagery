export interface AudioFadeOptions {
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean;
  stopTime?: number;
  stopFadeOut?: number;
}

interface AudioEntry {
  key: string;
  audio: HTMLAudioElement;
  startTime: number;
  duration: number;
  volume: number;
  fadeIn: number;
  fadeOut?: number;
  loop: boolean;
  stopTime?: number;
  stopFadeOut?: number;
  stopFadeOutSet: boolean;
  order: number;
  playRequested: boolean;
}

interface AudioElementMetadata extends AudioFadeOptions {
  stopFadeOutSet?: boolean;
  disposed?: boolean;
}

const AUDIO_METADATA = Symbol('aeonstagery.audio.metadata');
// Small clock differences are normal during playback; larger drift or seeks
// still need an explicit position correction.
const AUDIO_POSITION_RESYNC_THRESHOLD_SECONDS = 0.25;

/**
 * Attach the same interval metadata to an audio element that the preview
 * coordinator and the export interval collector use.
 *
 * The scheduler exposes a deliberately small Map-shaped seam, so metadata is
 * carried by the element rather than by widening that shared Map contract.
 */
export function configureAudioElement(audio: HTMLAudioElement, options: AudioFadeOptions): void {
  Object.assign(getAudioMetadata(audio), options);
}

/** Mark the interval's end without removing its definition from the timeline. */
export function markAudioElementStop(
  audio: HTMLAudioElement,
  stopTime: number,
  fadeOut?: number,
): void {
  const metadata = getAudioMetadata(audio);
  metadata.stopTime = stopTime;
  metadata.stopFadeOutSet = fadeOut !== undefined;
  if (fadeOut !== undefined) metadata.stopFadeOut = fadeOut;
}

/** Prevent an outstanding asynchronous path resolution from reviving an old entry. */
export function markAudioElementDisposed(audio: HTMLAudioElement): void {
  getAudioMetadata(audio).disposed = true;
}

/** Used by audio action path resolution to avoid a post-cleanup source write. */
export function isAudioElementDisposed(audio: HTMLAudioElement): boolean {
  return getAudioMetadata(audio).disposed === true;
}

function getAudioMetadata(audio: HTMLAudioElement): AudioElementMetadata {
  const element = audio as HTMLAudioElement & { [AUDIO_METADATA]?: AudioElementMetadata };
  if (!element[AUDIO_METADATA]) {
    Object.defineProperty(element, AUDIO_METADATA, {
      configurable: true,
      value: {},
      writable: true,
    });
  }
  return element[AUDIO_METADATA]!;
}

/**
 * A Map-shaped view keeps the existing ScriptEngine adapter contract intact:
 * get() sees the latest scheduled definition while values() exposes only
 * entries active at the last synchronization point.
 */
class AudioEntriesView extends Map<string, AudioEntry> {
  constructor(private readonly owner: AudioCoordinator) {
    super();
  }

  override get(key: string): AudioEntry | undefined {
    return this.owner.getLatestScheduledEntry(key);
  }

  override has(key: string): boolean {
    return this.owner.hasActiveEntry(key);
  }

  override get size(): number {
    return this.owner.activeEntryCount;
  }

  override values(): MapIterator<AudioEntry> {
    return this.owner.getActiveEntries().values();
  }

  override keys(): MapIterator<string> {
    return this.owner.getActiveEntries().keys();
  }

  override entries(): MapIterator<[string, AudioEntry]> {
    return this.owner.getActiveEntries().entries();
  }

  override [Symbol.iterator](): MapIterator<[string, AudioEntry]> {
    return this.entries();
  }

  override forEach(callbackfn: (value: AudioEntry, key: string, map: Map<string, AudioEntry>) => void, thisArg?: unknown): void {
    this.owner.getActiveEntries().forEach(callbackfn, thisArg);
  }

  override delete(key: string): boolean {
    return this.owner.removeActiveEntry(key);
  }

  override clear(): void {
    this.owner.clear();
  }
}

export class AudioCoordinator {
  private resumeAudioGraph?: () => void | Promise<void>;
  private readonly scheduledEntries: AudioEntry[] = [];
  private readonly latestScheduledEntries = new Map<string, AudioEntry>();
  private readonly activeEntries = new Map<string, AudioEntry>();
  private readonly entriesView = new AudioEntriesView(this);
  private nextOrder = 0;
  private lastSyncTime?: number;

  constructor(resumeAudioGraph?: () => void | Promise<void>) {
    this.resumeAudioGraph = resumeAudioGraph;
  }

  /** Register an audio element and its complete timeline interval. */
  scheduleAudio(
    key: string,
    audio: HTMLAudioElement,
    startTime: number,
    duration: number,
    options?: AudioFadeOptions,
  ): void {
    const previous = this.latestScheduledEntries.get(key);
    if (previous && startTime >= previous.startTime) {
      previous.stopTime = Math.min(previous.stopTime ?? Number.POSITIVE_INFINITY, startTime);
    }

    const metadata = getAudioMetadata(audio);
    const usesLegacyBgmDefaults = key === 'bgm'
      && options === undefined
      && metadata.volume === undefined
      && audio.volume === 0;
    const volume = nonNegativeNumber(options?.volume)
      ? options!.volume!
      : nonNegativeNumber(metadata.volume)
        ? metadata.volume!
        : usesLegacyBgmDefaults
          ? 0.5
        : nonNegativeNumber(audio.volume)
          ? audio.volume
          : 1;
    const fadeIn = nonNegativeNumber(options?.fadeIn)
      ? options!.fadeIn!
      : nonNegativeNumber(metadata.fadeIn)
        ? metadata.fadeIn!
        : usesLegacyBgmDefaults
          ? 2
        : 0;
    const fadeOut = nonNegativeNumber(options?.fadeOut)
      ? options!.fadeOut!
      : nonNegativeNumber(metadata.fadeOut)
        ? metadata.fadeOut
        : undefined;
    const stopFadeOutSet = options?.stopFadeOut !== undefined
      ? true
      : metadata.stopFadeOutSet === true;

    const entry: AudioEntry = {
      key,
      audio,
      startTime,
      duration,
      volume,
      fadeIn,
      ...(fadeOut !== undefined ? { fadeOut } : {}),
      loop: options?.loop ?? metadata.loop ?? audio.loop,
      ...(options?.stopTime !== undefined
        ? { stopTime: options.stopTime }
        : metadata.stopTime !== undefined
          ? { stopTime: metadata.stopTime }
          : {}),
      ...(stopFadeOutSet
        ? { stopFadeOut: options?.stopFadeOut ?? metadata.stopFadeOut }
        : {}),
      stopFadeOutSet,
      order: this.nextOrder++,
      playRequested: false,
    };

    this.scheduledEntries.push(entry);
    this.latestScheduledEntries.set(key, entry);
  }

  /**
   * Synchronize all audio positions, volume envelopes, and play state to the
   * given timeline time. Fade envelopes are linear and are evaluated from the
   * interval endpoints, so seeking and forward playback use identical values.
   */
  sync(time: number, playing: boolean): void {
    const desired = new Map<string, AudioEntry>();
    const timelineReversed = this.lastSyncTime !== undefined && time < this.lastSyncTime;

    for (const entry of this.scheduledEntries) {
      this.refreshEntryMetadata(entry);
      if (time < entry.startTime || time >= this.getEndTime(entry)) continue;

      const key = this.getEntryKey(entry);
      const current = desired.get(key);
      if (!current || entry.startTime > current.startTime || entry.order > current.order) {
        desired.set(key, entry);
      }
    }

    for (const entry of this.scheduledEntries) {
      if (!desired.has(entry.key)) this.pauseEntry(entry);
    }

    for (const [key, entry] of this.activeEntries) {
      if (desired.get(key) !== entry) {
        this.pauseEntry(entry);
        this.activeEntries.delete(key);
      }
    }

    for (const [key, entry] of desired) {
      const wasActive = this.activeEntries.get(key) === entry;
      this.activeEntries.set(key, entry);
      this.syncEntry(key, entry, time, playing, !wasActive || !playing || timelineReversed);
    }

    this.lastSyncTime = time;
  }

  getEntries(): Map<string, AudioEntry> {
    return this.entriesView;
  }

  getLatestScheduledEntry(key: string): AudioEntry | undefined {
    return this.latestScheduledEntries.get(key);
  }

  getActiveEntries(): Map<string, AudioEntry> {
    return this.activeEntries;
  }

  get activeEntryCount(): number {
    return this.activeEntries.size;
  }

  hasActiveEntry(key: string): boolean {
    return this.activeEntries.has(key);
  }

  removeActiveEntry(key: string): boolean {
    const entry = this.activeEntries.get(key);
    if (!entry) return false;
    this.pauseEntry(entry);
    this.activeEntries.delete(key);
    return true;
  }

  /** Pause and remove all audio elements and all retained interval definitions. */
  clear(): void {
    const seen = new Set<HTMLAudioElement>();
    for (const entry of this.scheduledEntries) {
      if (seen.has(entry.audio)) continue;
      seen.add(entry.audio);
      markAudioElementDisposed(entry.audio);
      this.pauseEntry(entry);
      entry.audio.src = '';
    }
    this.activeEntries.clear();
    this.latestScheduledEntries.clear();
    this.scheduledEntries.length = 0;
    this.lastSyncTime = undefined;
  }

  private refreshEntryMetadata(entry: AudioEntry): void {
    const metadata = getAudioMetadata(entry.audio);
    if (metadata.stopTime !== undefined) entry.stopTime = metadata.stopTime;
    if (metadata.stopFadeOutSet === true) {
      entry.stopFadeOutSet = true;
      entry.stopFadeOut = metadata.stopFadeOut;
    }
  }

  private getEntryKey(entry: AudioEntry): string {
    return entry.key;
  }

  private getEndTime(entry: AudioEntry): number {
    const naturalEnd = Number.isFinite(entry.duration)
      ? entry.startTime + Math.max(0, entry.duration)
      : Number.POSITIVE_INFINITY;
    return Math.min(
      naturalEnd,
      entry.stopTime ?? Number.POSITIVE_INFINITY,
    );
  }

  private syncEntry(
    key: string,
    entry: AudioEntry,
    time: number,
    playing: boolean,
    forcePositionSync: boolean,
  ): void {
    const relativeTime = Math.max(0, time - entry.startTime);
    const endTime = this.getEndTime(entry);
    const fadeOut = entry.stopFadeOutSet ? entry.stopFadeOut : entry.fadeOut;
    const fadeInFactor = entry.fadeIn > 0
      ? clamp((time - entry.startTime) / entry.fadeIn)
      : 1;
    const fadeOutFactor = fadeOut !== undefined && fadeOut > 0 && Number.isFinite(endTime)
      ? clamp((endTime - time) / fadeOut)
      : 1;

    entry.audio.volume = Math.max(0, entry.volume * fadeInFactor * fadeOutFactor);

    const mediaDuration = entry.audio.duration;
    const looped = key === 'bgm' || entry.loop;
    const targetTime = looped && mediaDuration > 0 && Number.isFinite(mediaDuration)
      ? ((relativeTime % mediaDuration) + mediaDuration) % mediaDuration
      : relativeTime;
    if (forcePositionSync || positionDriftExceedsThreshold(entry.audio, targetTime, looped, mediaDuration)) {
      try {
        entry.audio.currentTime = targetTime;
      } catch {
        // Browsers can reject currentTime writes while an async source is loading.
      }
    }

    if (playing && !isAudioElementDisposed(entry.audio)) {
      this.ensurePlaying(entry);
    } else {
      this.pauseEntry(entry);
    }
  }

  private ensurePlaying(entry: AudioEntry): void {
    if (entry.playRequested) return;

    // An action callback or a caller outside this coordinator may have
    // started the element already. Record that state without calling play()
    // again on every timeline update.
    if (entry.audio.paused === false) {
      entry.playRequested = true;
      return;
    }

    entry.playRequested = true;
    void Promise.resolve(this.resumeAudioGraph?.()).catch(() => {});
    try {
      void entry.audio.play().catch(() => {
        entry.playRequested = false;
      });
    } catch {
      entry.playRequested = false;
    }
  }

  private pauseEntry(entry: AudioEntry): void {
    entry.playRequested = false;
    entry.audio.pause();
  }
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positionDriftExceedsThreshold(
  audio: HTMLAudioElement,
  targetTime: number,
  looped: boolean,
  mediaDuration: number,
): boolean {
  const currentTime = audio.currentTime;
  if (!Number.isFinite(currentTime) || !Number.isFinite(targetTime)) return true;

  let drift = Math.abs(currentTime - targetTime);
  if (looped && mediaDuration > 0 && Number.isFinite(mediaDuration)) {
    const normalizedCurrent = ((currentTime % mediaDuration) + mediaDuration) % mediaDuration;
    const normalizedTarget = ((targetTime % mediaDuration) + mediaDuration) % mediaDuration;
    drift = Math.abs(normalizedCurrent - normalizedTarget);
    drift = Math.min(drift, mediaDuration - drift);
  }

  return drift > AUDIO_POSITION_RESYNC_THRESHOLD_SECONDS;
}
