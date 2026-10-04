import type { CurrentSceneDocument } from '../../../api/types/semantic-scene';

/**
 * A post-conversion pass that turns the raw `vocal/...` voice references
 * produced by the converter into playable references with real durations.
 * It stays I/O-free itself: the caller supplies how to resolve a reference to
 * a filesystem path and how to measure a WAV file's duration.
 */

const DEFAULT_VOICE_BUFFER_SECONDS = 0.5;

/**
 * Candidates to try for a voice reference, most specific first. WebGAL projects
 * place dialogue voices under `vocal/`, but some games keep them next to the
 * figure or at the asset root, so the fallbacks cover those layouts.
 */
export function webGalVoiceCandidates(reference: string): string[] {
  const normalized = reference.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments[0] === '@mount' && segments.length >= 4 && segments[2] === 'vocal') {
    const mountId = segments[1];
    const rest = segments.slice(3).join('/');
    return [normalized, `@mount/${mountId}/figure/${rest}`, `@mount/${mountId}/${rest}`];
  }
  if (segments[0] === 'vocal' && segments.length >= 2) {
    const rest = segments.slice(1).join('/');
    return [normalized, `figure/${rest}`, rest];
  }
  return [normalized];
}

export interface WebGalVoiceTimingOptions {
  /** Reading pace multiplier; a faster speed shortens the trailing buffer. */
  speed?: number;
  /** Resolves a scene asset reference to a machine-local filesystem path. */
  resolveAudio: (reference: string) => Promise<string>;
  /** Reads an audio file and returns its duration in seconds, or null when unavailable. */
  readAudioDuration: (fsPath: string) => Promise<number | null>;
}

export interface WebGalVoiceTimingResult {
  /** The scene with timed dialogue replaced; unchanged when nothing timed. */
  document: CurrentSceneDocument;
  /** Dialogue lines whose hold time now follows their real voice duration. */
  timed: number;
  /** Dialogue lines with a voice reference whose audio could not be read. */
  missing: number;
}

export async function applyWebGalVoiceTiming(
  document: CurrentSceneDocument,
  options: WebGalVoiceTimingOptions,
): Promise<WebGalVoiceTimingResult> {
  const speed = Math.max(0.1, options.speed ?? 1);
  const bufferSeconds = DEFAULT_VOICE_BUFFER_SECONDS / speed;
  let timed = 0;
  let missing = 0;
  let changed = false;
  const statements = document.statements.map((statement) => ({ ...statement }));

  // Statements carry absolute timeline times baked from the text-based
  // duration estimate, so a re-timed dialogue must push every later statement
  // forward (or back) by the same delta — otherwise the next line starts
  // while the longer voice is still playing and the dialogues overlap.
  let shift = 0;
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    let updated = statement;
    if (shift !== 0) {
      updated = { ...statement, time: statement.time + shift };
      changed = true;
    }
    if (updated.type !== 'dialogue') {
      statements[index] = updated;
      continue;
    }
    const params = updated.params;
    if (!params.voice) {
      statements[index] = updated;
      continue;
    }
    const voice = params.voice;

    let duration: number | null = null;
    let resolved = voice;
    for (const candidate of webGalVoiceCandidates(voice)) {
      let fsPath: string;
      try {
        fsPath = await options.resolveAudio(candidate);
      } catch {
        continue;
      }
      try {
        duration = await options.readAudioDuration(fsPath);
      } catch {
        duration = null;
      }
      if (duration !== null) {
        resolved = candidate;
        break;
      }
    }

    if (duration === null) {
      missing += 1;
      statements[index] = updated;
      continue;
    }
    timed += 1;
    changed = true;
    const nextDuration = Number((duration + bufferSeconds).toFixed(3));
    shift += nextDuration - (params.durationSeconds ?? 0);
    statements[index] = {
      ...updated,
      params: { ...params, voice: resolved, durationSeconds: nextDuration },
    };
  }

  return {
    document: changed ? { ...document, statements } : document,
    timed,
    missing,
  };
}

/**
 * Reads a browser-supported audio file's duration. The browser decoder covers
 * formats such as MP3, OGG, M4A and AAC; WAV parsing remains available as a
 * fallback for tests and non-browser callers.
 */
export async function audioDurationSeconds(data: ArrayBuffer): Promise<number | null> {
  const AudioContextConstructor = globalThis.AudioContext;
  if (typeof AudioContextConstructor === 'function') {
    const audioContext = new AudioContextConstructor();
    try {
      const decoded = await audioContext.decodeAudioData(data.slice(0));
      return Number.isFinite(decoded.duration) && decoded.duration > 0 ? decoded.duration : null;
    } catch {
      // Fall through to the RIFF parser for environments with partial codec support.
    } finally {
      await audioContext.close().catch(() => undefined);
    }
  }

  return wavDurationSeconds(data);
}

/** Reads a WAV file's duration in seconds from its RIFF header, or null. */
export function wavDurationSeconds(data: ArrayBuffer): number | null {
  const bytes = new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44 || asciiAt(bytes, 0) !== 'RIFF' || asciiAt(bytes, 8) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let byteRate = 0;
  let dataChunkSize = 0;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = asciiAt(bytes, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'fmt ' && chunkSize >= 16 && offset + 24 <= bytes.byteLength) {
      byteRate = view.getUint32(offset + 16, true);
    }
    if (chunkId === 'data') {
      dataChunkSize = chunkSize;
      break;
    }
    if (chunkSize === 0) break;
    offset = offset + 8 + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || dataChunkSize <= 0 || dataChunkSize === 0xffffffff) return null;
  const seconds = dataChunkSize / byteRate;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function asciiAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
