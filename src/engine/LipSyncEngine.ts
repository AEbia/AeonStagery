/**
 * AeonStagery — Lip Sync Engine
 *
 * Automatic lip synchronization for Live2D characters:
 *
 * Mode A — Text-driven (no voice):
 *   Generates a natural mouth open/close rhythm based on text content.
 *   Uses character count, punctuation pauses, and natural variation.
 *
 * Mode B — Audio-driven (with voice):
 *   Real-time audio volume analysis → mouth openness mapping.
 *   Uses Web Audio API AnalyserNode to extract volume from voice audio.
 */

import gsap from 'gsap';
import { live2DManager } from './Live2DManager';

// Live2D parameter names for mouth control
const PARAM_MOUTH_OPEN = 'PARAM_MOUTH_OPEN_Y';

// Chinese/Japanese punctuation that causes a pause
const PAUSE_CHARS = new Set(['，', '。', '！', '？', '…', '、', '；', '：',
  ',', '.', '!', '?', ';', ':', '—', '──']);

// Longer pauses
const LONG_PAUSE_CHARS = new Set(['。', '！', '？', '…', '.', '!', '?']);

interface ActiveLipSync {
  type: 'text' | 'audio';
  timeline?: gsap.core.Timeline;
  analyser?: AnalyserNode;
  audioContext?: AudioContext;
  source?: MediaElementAudioSourceNode;
  animFrameId?: number;
  characterId: string;
}

/**
 * Deterministic 0..1 hash of a unit index within a text. Replaces Math.random
 * so the text-driven rhythm (syllable openness, pause lengths) is identical
 * across playback ticks, scrub seeks and bake — required because the mouth
 * driver is per-frame deterministic while the legacy GSAP timeline is no
 * longer the playback authority.
 */
function deterministicUnit(text: string, index: number): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash = (hash ^ Math.imul(index, 2654435761)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash / 4294967296;
}

class LipSyncEngine {
  private activeSyncs: Map<string, ActiveLipSync> = new Map();
  private sensitivity: Map<string, number> = new Map();

  /**
   * Mode A: Text-driven lip sync.
   *
   * Generates a GSAP timeline that opens/closes the character's mouth
   * in a natural speech rhythm based on the text content.
   *
   * NOTE: Playback no longer relies on this timeline. GSAP `seek()` does not
   * fire tween onUpdate callbacks, so a timeline driven only through
   * `seek()` — which is how DialogueCoordinator drives lip sync every tick —
   * never wrote the mouth during playback and left the character frozen (the
   * timeline then free-ran on the global ticker once pausing stopped the
   * seeks). The playback/scrub authority is now the deterministic
   * `setTextMouthAt` driver below; this timeline is retained for callers who
   * explicitly play it and for the legacy unit tests.
   */
  startTextDrivenLipSync(
    characterId: string,
    text: string,
    duration: number
  ): gsap.core.Timeline {
    const tl = gsap.timeline({
      onStart: () => {
        // Set this as the active sync when it actually starts playing
        this.activeSyncs.set(characterId, {
          type: 'text',
          timeline: tl,
          characterId,
        });
      },
      onComplete: () => {
        // Ensure mouth is closed at end, then release the channel ownership
        this.closeMouthAndRelease(characterId);
        // Only delete if it's still THIS timeline
        if (this.activeSyncs.get(characterId)?.timeline === tl) {
          this.activeSyncs.delete(characterId);
        }
      },
      onReverseComplete: () => {
        // Clean up if we seek backward past the start
        if (this.activeSyncs.get(characterId)?.timeline === tl) {
          this.closeMouthAndRelease(characterId);
          this.activeSyncs.delete(characterId);
        }
      }
    });

    this.activeSyncs.set(characterId, {
      type: 'text',
      timeline: tl,
      characterId,
    });

    // Parse text into syllable units with pause markers
    const units = this.parseTextToUnits(text);
    if (units.length === 0) return tl;

    // Calculate timing
    const totalSyllables = units.filter(u => u.type === 'syllable').length;
    const totalPauseTime = units
      .filter(u => u.type === 'pause')
      .reduce((sum, u) => sum + u.pauseDuration!, 0);

    const availableSpeechTime = Math.max(duration - totalPauseTime, duration * 0.5);
    const timePerSyllable = availableSpeechTime / Math.max(totalSyllables, 1);

    // Mouth value proxy for GSAP to animate
    const mouth = { value: 0 };
    let currentTime = 0;

    for (const unit of units) {
      if (unit.type === 'pause') {
        // Close mouth during pause
        tl.to(mouth, {
          value: 0,
          duration: 0.05,
          ease: 'power2.out',
          onUpdate: () => {
            this.setMouthOpen(characterId, mouth.value);
          },
        }, currentTime);
        currentTime += unit.pauseDuration!;
      } else {
        // Natural speech syllable
        const syllableDur = timePerSyllable;

        // Vary the mouth openness for natural feel (0.8 ~ 1.5 to be visible)
        const openness = 0.8 + Math.random() * 0.7;

        // Open phase (30% of syllable time)
        tl.to(mouth, {
          value: openness,
          duration: Math.max(0.01, syllableDur * 0.3),
          ease: 'power2.out',
          onUpdate: () => {
            this.setMouthOpen(characterId, mouth.value);
          },
        }, currentTime);

        // Hold phase (40% of syllable time) — slight variation
        tl.to(mouth, {
          value: openness * (0.7 + Math.random() * 0.3),
          duration: Math.max(0.01, syllableDur * 0.4),
          ease: 'sine.inOut',
          onUpdate: () => {
            this.setMouthOpen(characterId, mouth.value);
          },
        }, currentTime + syllableDur * 0.3);

        // Close phase (30% of syllable time)
        tl.to(mouth, {
          value: 0.05 + Math.random() * 0.1, // Not fully closed between syllables
          duration: Math.max(0.01, syllableDur * 0.3),
          ease: 'power2.in',
          onUpdate: () => {
            this.setMouthOpen(characterId, mouth.value);
          },
        }, currentTime + syllableDur * 0.7);

        currentTime += syllableDur;
      }
    }

    // Final close
    tl.to(mouth, {
      value: 0,
      duration: 0.1,
      ease: 'power2.out',
      onUpdate: () => {
        this.setMouthOpen(characterId, mouth.value);
      },
    }, currentTime);

    return tl;
  }

  /**
   * Deterministic text→mouth openness at a scene offset — the playback and
   * scrub authority for text-driven lip sync.
   *
   * Uses the same syllable/pause timing model and phase shapes as the legacy
   * GSAP timeline, but every value derives from the text (via
   * `deterministicUnit`), so the same (text, duration, offset) always yields
   * the same openness: no flicker between playback ticks and scrub seeks, and
   * no dependence on GSAP firing onUpdate (which `seek()` does not guarantee).
   */
  computeTextMouthOpenness(text: string, duration: number, offset: number): number {
    if (!text || !(duration > 0) || offset < 0 || offset > duration) return 0;

    const units = this.parseTextToUnits(text);
    if (units.length === 0) return 0;

    const totalSyllables = units.filter((unit) => unit.type === 'syllable').length;
    const totalPauseTime = units
      .filter((unit) => unit.type === 'pause')
      .reduce((sum, unit) => sum + (unit.pauseDuration ?? 0), 0);
    const availableSpeechTime = Math.max(duration - totalPauseTime, duration * 0.5);
    const timePerSyllable = availableSpeechTime / Math.max(totalSyllables, 1);

    let currentTime = 0;
    let syllableIndex = 0;
    for (const unit of units) {
      if (unit.type === 'pause') {
        if (offset < currentTime + (unit.pauseDuration ?? 0)) return 0; // mouth closed during pause
        currentTime += unit.pauseDuration ?? 0;
        continue;
      }

      const openness = 0.8 + deterministicUnit(text, syllableIndex) * 0.7;      // 0.8 ~ 1.5
      const holdTarget = openness * (0.7 + deterministicUnit(text, syllableIndex + totalSyllables) * 0.3);
      const closeTarget = 0.05 + deterministicUnit(text, syllableIndex + totalSyllables * 2) * 0.1;

      const openDur = Math.max(0.01, timePerSyllable * 0.3);
      const holdDur = Math.max(0.01, timePerSyllable * 0.4);
      const closeDur = Math.max(0.01, timePerSyllable * 0.3);

      if (offset < currentTime + openDur) {
        const p = (offset - currentTime) / openDur;
        return openness * (1 - Math.pow(1 - p, 2)); // power2.out
      }
      if (offset < currentTime + openDur + holdDur) {
        const p = (offset - currentTime - openDur) / holdDur;
        return holdTarget + (openness - holdTarget) * (0.5 - 0.5 * Math.cos(p * Math.PI)); // sine.inOut
      }
      if (offset < currentTime + openDur + holdDur + closeDur) {
        const p = (offset - currentTime - openDur - holdDur) / closeDur;
        return holdTarget + (closeTarget - holdTarget) * p * p; // power2.in
      }

      currentTime += timePerSyllable;
      syllableIndex += 1;
    }

    return 0;
  }

  /**
   * Imperative text-driven mouth driver used by DialogueCoordinator on every
   * playback/scrub tick. Registers the text sync record so `stop()`/`clear()`
   * still close the mouth and release the channel at dialogue end.
   */
  setTextMouthAt(characterId: string, text: string, duration: number, offset: number): void {
    const existing = this.activeSyncs.get(characterId);
    if (!existing || existing.type !== 'text') {
      this.activeSyncs.set(characterId, { type: 'text', characterId });
    }
    this.setMouthOpen(characterId, this.computeTextMouthOpenness(text, duration, offset));
  }

  /**
   * Mode B: Audio-driven lip sync.
   *
   * Analyzes real-time audio volume and maps it to mouth openness.
   * Uses Web Audio API AnalyserNode for frequency analysis.
   */
  async startAudioDrivenLipSync(
    characterId: string,
    audioElement: HTMLAudioElement
  ): Promise<void> {
    this.stop(characterId);

    audioElement.crossOrigin = 'anonymous';
    audioElement.preload = 'auto';

    const audioContext = new AudioContext();
    const source = audioContext.createMediaElementSource(audioElement);
    const analyser = audioContext.createAnalyser();

    // Configure analyser for voice frequency range
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6; // Moderate smoothing

    source.connect(analyser);
    analyser.connect(audioContext.destination);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // Human voice is roughly 100-500Hz
    // With fftSize=256 and 44100Hz sample rate:
    // Each bin = 44100/256 ≈ 172Hz
    // Bins 0-2 roughly cover 0-500Hz
    const voiceStartBin = 0;
    const voiceEndBin = Math.min(3, bufferLength);

    const sensitivity = this.sensitivity.get(characterId) ?? 1.0;
    let prevMouthValue = 0;

    const update = () => {
      analyser.getByteFrequencyData(dataArray);

      // Calculate average volume in voice frequency range
      let sum = 0;
      for (let i = voiceStartBin; i < voiceEndBin; i++) {
        sum += dataArray[i];
      }
      const avgVolume = sum / (voiceEndBin - voiceStartBin);

      // Normalize to 0-1 range and apply sensitivity
      let mouthValue = (avgVolume / 255) * sensitivity;

      // Apply threshold — very quiet = closed mouth
      if (mouthValue < 0.08) mouthValue = 0;

      // Smooth the transition (lerp with previous value)
      mouthValue = prevMouthValue + (mouthValue - prevMouthValue) * 0.4;
      prevMouthValue = mouthValue;

      // Clamp
      mouthValue = Math.min(Math.max(mouthValue, 0), 1);

      this.setMouthOpen(characterId, mouthValue);

      const sync = this.activeSyncs.get(characterId);
      if (sync && sync.type === 'audio') {
        sync.animFrameId = requestAnimationFrame(update);
      }
    };

    const animFrameId = requestAnimationFrame(update);

    this.activeSyncs.set(characterId, {
      type: 'audio',
      analyser,
      audioContext,
      source,
      animFrameId,
      characterId,
    });

    void this.resumeAudioDrivenSyncs();
  }

  async resumeAudioDrivenSyncs(): Promise<void> {
    const resumes: Promise<void>[] = [];
    for (const sync of this.activeSyncs.values()) {
      if (sync.type === 'audio' && sync.audioContext?.state === 'suspended') {
        resumes.push(sync.audioContext.resume().catch(() => {}));
      }
    }
    await Promise.all(resumes);
  }

  /**
   * Stop lip sync for a character.
   */
  stop(characterId: string): void {
    const sync = this.activeSyncs.get(characterId);
    if (!sync) return;

    if (sync.type === 'text' && sync.timeline) {
      sync.timeline.kill();
    }

    if (sync.type === 'audio') {
      if (sync.animFrameId) cancelAnimationFrame(sync.animFrameId);
      if (sync.source) sync.source.disconnect();
      if (sync.analyser) sync.analyser.disconnect();
      if (sync.audioContext) sync.audioContext.close();
    }

    // Close mouth, then release the channel ownership so a later custom
    // motion can drive the mouth parameters again (ADR-0029 stage handoff).
    this.setMouthOpen(characterId, 0);
    live2DManager.clearLipSyncParameters(characterId);
    this.activeSyncs.delete(characterId);
  }
  
  public getTimeline(characterId: string) { return this.activeSyncs.get(characterId)?.timeline; }

  /**
   * Adjust lip sync sensitivity for a character.
   * Higher = more responsive, lower = more subtle.
   * Default is 1.0.
   */
  setSensitivity(characterId: string, sensitivity: number): void {
    this.sensitivity.set(characterId, Math.max(0.1, Math.min(3.0, sensitivity)));
  }

  /**
   * Write a mouth value through the lip-sync effect channel and release the
   * channel ownership. The final 0 stays in injectedParams so the mouth
   * settles closed before any later motion takes the parameters over.
   */
  private closeMouthAndRelease(characterId: string): void {
    this.setMouthOpen(characterId, 0);
    live2DManager.clearLipSyncParameters(characterId);
  }

  private setMouthOpen(characterId: string, value: number): void {
    if (Number.isNaN(value)) return;
    // Route through the dedicated effect channel: while this sync is active
    // its parameters are protected from per-frame custom-motion overwrite and
    // release (ADR-0029 — lip sync keeps running in its normal stage).
    live2DManager.setLipSyncParameter(characterId, PARAM_MOUTH_OPEN, value);
    live2DManager.setLipSyncParameter(characterId, 'ParamMouthOpenY', value);
  }

  /**
   * Parse text into syllable/pause units.
   * Filters out text within parentheses (e.g., psychological descriptions or sound effects).
   */
  private parseTextToUnits(text: string): Array<{
    type: 'syllable' | 'pause';
    char?: string;
    pauseDuration?: number;
  }> {
    const units: Array<{ type: 'syllable' | 'pause'; char?: string; pauseDuration?: number }> = [];
    let isInsideParentheses = false;
    let index = 0;

    for (const char of text) {
      // Toggle parentheses state
      if (char === '(' || char === '（') {
        isInsideParentheses = true;
        continue;
      }
      if (char === ')' || char === '）') {
        isInsideParentheses = false;
        continue;
      }

      // Skip everything inside parentheses (psychological descriptions, SFX labels, etc.)
      if (isInsideParentheses) continue;

      if (char === ' ' || char === '\n' || char === '\r') {
        // Small pause for spaces
        units.push({ type: 'pause', pauseDuration: 0.08 });
      } else if (LONG_PAUSE_CHARS.has(char)) {
        units.push({ type: 'pause', pauseDuration: 0.3 + deterministicUnit(text, index) * 0.15 });
      } else if (PAUSE_CHARS.has(char)) {
        units.push({ type: 'pause', pauseDuration: 0.15 + deterministicUnit(text, index) * 0.1 });
      } else {
        units.push({ type: 'syllable', char });
      }
      index += 1;
    }

    return units;
  }

  /**
   * Stop all active lip syncs.
   */
  clear(): void {
    for (const id of this.activeSyncs.keys()) {
      this.stop(id);
    }
  }
}

export const lipSyncEngine = new LipSyncEngine();
export default LipSyncEngine;
