import type { PreparedCompiledScene } from '../../api/types/semantic-scene';

interface MouthTarget {
  setLipSyncParameter(characterId: string, parameter: string, value: number): void;
  clearLipSyncParameters(characterId: string): void;
}

interface VoiceClip {
  start: number;
  end: number;
  speaker: string;
  buffer?: AudioBuffer;
  text: string;
  duration: number;
}

/** Voice sampling uses scene time, so paused audio and asynchronous frame capture cannot freeze it. */
export class ExportVoiceLipSync {
  private clips: VoiceClip[] = [];
  private activeSpeaker: string | null = null;

  constructor(
    private readonly target: MouthTarget,
    private readonly stopRealtime: (speaker: string) => void,
    private readonly textMouth: (text: string, duration: number, offset: number) => number,
  ) {}

  async prepare(
    scene: PreparedCompiledScene,
    rangeStart: number,
    rangeEnd: number,
    loadVoice: (scene: PreparedCompiledScene) => Promise<ArrayBuffer>,
  ): Promise<void> {
    const decoded = new Map<string, AudioBuffer | undefined>();
    let context: OfflineAudioContext | undefined;
    const actions = [...scene.actions].sort((a, b) => a.time - b.time);
    const dialogues = actions.filter((action) => action.action === 'dialogue');
    for (let index = 0; index < dialogues.length; index++) {
      const action = dialogues[index];
      const { voice, speakerId, duration, lipSync } = action.params;
      const start = action.time;
      const end = Math.min(start + (typeof duration === 'number' ? duration : 5), dialogues[index + 1]?.time ?? Infinity);
      if (!voice || typeof speakerId !== 'string' || lipSync === 'none' || end <= rangeStart || start >= rangeEnd) continue;
      const key = typeof voice === 'string' ? voice : JSON.stringify(voice);
      let buffer = decoded.get(key);
      if (!decoded.has(key)) {
        try {
          const bytes = await loadVoice({ ...scene, actions: [action] });
          context ??= new OfflineAudioContext(1, 1, 44100);
          buffer = await context.decodeAudioData(bytes.slice(0));
        } catch {
          // Audio collection historically skips unavailable clips; mouth analysis must not block export.
          console.warn(`[ExportVoiceLipSync] Voice analysis unavailable for dialogue ${action.id}; using text timing.`);
        }
        decoded.set(key, buffer);
      }
      this.clips.push({ start, end, speaker: speakerId, buffer, text: String(action.params.text ?? ''), duration: typeof duration === 'number' ? duration : 5 });
    }
  }

  beforeSeek(time: number): void {
    const clip = this.clips.find((candidate) => time >= candidate.start && time < candidate.end);
    if (this.activeSpeaker && this.activeSpeaker !== clip?.speaker) this.release();
  }

  applyAtTime(time: number): void {
    const clip = this.clips.find((candidate) => time >= candidate.start && time < candidate.end);
    if (this.activeSpeaker && this.activeSpeaker !== clip?.speaker) this.release();
    if (!clip) return;
    this.stopRealtime(clip.speaker);
    this.activeSpeaker = clip.speaker;
    if (!clip.buffer) {
      this.write(clip.speaker, this.textMouth(clip.text, clip.duration, time - clip.start));
      return;
    }
    const offset = Math.floor((time - clip.start) * clip.buffer.sampleRate);
    const end = Math.min(clip.buffer.length, offset + Math.ceil(clip.buffer.sampleRate * 0.02));
    let energy = 0;
    for (let channel = 0; channel < clip.buffer.numberOfChannels; channel++) {
      const samples = clip.buffer.getChannelData(channel);
      for (let sample = offset; sample < end; sample++) energy += samples[sample] ** 2;
    }
    const count = Math.max(0, end - offset) * clip.buffer.numberOfChannels;
    const rms = count > 0 ? Math.sqrt(energy / count) : 0;
    const openness = rms < 0.01 ? 0 : Math.min(1, rms * 4);
    this.write(clip.speaker, openness);
  }

  dispose(): void {
    this.release();
    this.clips = [];
  }

  private write(speaker: string, value: number): void {
    this.target.setLipSyncParameter(speaker, 'PARAM_MOUTH_OPEN_Y', value);
    this.target.setLipSyncParameter(speaker, 'ParamMouthOpenY', value);
  }

  private release(): void {
    if (!this.activeSpeaker) return;
    this.write(this.activeSpeaker, 0);
    this.target.clearLipSyncParameters(this.activeSpeaker);
    this.activeSpeaker = null;
  }
}
