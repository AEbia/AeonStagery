interface DesiredDialogue {
  _id: string;
  text: string;
  startTime: number;
  duration?: number;
  speakerId?: string;
  voice?: string;
  lipSync?: 'audio' | 'text' | 'none';
}

interface SubtitleMuscle {
  setDialogueVisibility(visible: boolean, opacity: number): void;
  ensureDialogueOnStage(dialogue: any, offset: number): void;
  getCurrentTimeline(): gsap.core.Timeline | null;
  forceUpdate(): void;
  hideDialogue(animate: boolean): void;
}

interface LipSyncMuscle {
  /**
   * Imperative text-driven mouth driver: write the deterministic mouth
   * openness for the dialogue at the given scene offset. Called on every
   * playback/scrub tick — GSAP timeline `.seek()` was previously used but
   * does not fire tween onUpdate callbacks, so the mouth never moved during
   * playback and the orphan timeline free-ran on the global ticker once
   * pausing stopped the seeks.
   */
  setTextMouthAt(characterId: string, text: string, duration: number, offset: number): void;
  startAudioDrivenLipSync(speakerId: string, audio: HTMLAudioElement): void;
  stop(speakerId: string): void;
}

export class DialogueCoordinator {
  private subtitle: SubtitleMuscle;
  private lipSync: LipSyncMuscle;

  // Active dialogue tracking state
  private activeDialogueId: string | null = null;
  private activeDialogueStartTime: number = 0;
  private activeSpeakerId: string | null = null;
  private activeVoiceKey: string | null = null;
  private activeVoiceScheduled = false;

  constructor(subtitle: SubtitleMuscle, lipSync: LipSyncMuscle) {
    this.subtitle = subtitle;
    this.lipSync = lipSync;
  }

  /**
   * Synchronize dialogue state at the given target time.
   *
   * @param time         — target scene timeline time in seconds
   * @param dialogue     — active dialogue computed for this time, or null
   * @param isScrubbing  — if true, skip non-essential heavy updates (voice audio, starting text lipSync)
   * @param createAudio  — factory function for creating voice HTMLAudioElement
   * @param resolvePath  — resolver from asset:// or relative to absolute/runtime URL
   * @param scheduleVoice - callback when a new voice element needs to be scheduled by the Conductor
   */
  sync(
    time: number,
    dialogue: DesiredDialogue | null,
    isScrubbing: boolean,
    createAudio: (src: string) => HTMLAudioElement,
    resolvePath: (p: string) => string | Promise<string>,
    scheduleVoice: (voiceKey: string, audio: HTMLAudioElement, startTime: number, duration: number) => void,
    visible: boolean = true,
    opacity: number = visible ? 1 : 0,
  ): void {
    this.subtitle.setDialogueVisibility(visible, opacity);
    if (dialogue) {
      const offset = time - dialogue.startTime;

      if (this.activeDialogueId !== dialogue._id) {
        const voice = dialogue.voice;
        if (this.activeSpeakerId) {
          this.lipSync.stop(this.activeSpeakerId);
        }

        this.activeDialogueId = dialogue._id;
        this.activeDialogueStartTime = dialogue.startTime;
        this.activeSpeakerId = dialogue.speakerId ?? null;
        this.activeVoiceKey = voice ? this.getVoiceKey(dialogue) : null;
        this.activeVoiceScheduled = false;

        this.subtitle.ensureDialogueOnStage(dialogue, offset);

        if (voice) {
          this.scheduleVoiceIfNeeded(dialogue, isScrubbing, createAudio, resolvePath, scheduleVoice);
        } else if (dialogue.speakerId && dialogue.lipSync !== 'none') {
          // Text-driven lip sync is deterministic and cheap enough for seek/scrub.
          this.lipSync.setTextMouthAt(
            dialogue.speakerId,
            dialogue.text,
            dialogue.duration ?? 3,
            offset
          );
        }
      } else {
        // Same dialogue — seek active timelines
        this.scheduleVoiceIfNeeded(dialogue, isScrubbing, createAudio, resolvePath, scheduleVoice);
        this.subtitle.getCurrentTimeline()?.seek(offset);
        this.subtitle.forceUpdate();
        
        if (dialogue.speakerId && !dialogue.voice && dialogue.lipSync !== 'none') {
          this.lipSync.setTextMouthAt(
            dialogue.speakerId,
            dialogue.text,
            dialogue.duration ?? 3,
            offset
          );
        }
      }
    } else {
      if (this.activeDialogueId !== null) {
        this.subtitle.hideDialogue(false);
        if (this.activeSpeakerId) {
          this.lipSync.stop(this.activeSpeakerId);
        }
        this.activeDialogueId = null;
        this.activeSpeakerId = null;
        this.activeVoiceKey = null;
        this.activeVoiceScheduled = false;
      }
    }
  }

  private getVoiceKey(dialogue: DesiredDialogue): string {
    return `voice-${dialogue._id || `${dialogue.speakerId || 'dialogue'}-${dialogue.startTime}`}`;
  }

  private scheduleVoiceIfNeeded(
    dialogue: DesiredDialogue,
    isScrubbing: boolean,
    createAudio: (src: string) => HTMLAudioElement,
    resolvePath: (p: string) => string | Promise<string>,
    scheduleVoice: (voiceKey: string, audio: HTMLAudioElement, startTime: number, duration: number) => void
  ): void {
    if (!dialogue.voice || isScrubbing) return;

    const voiceKey = this.getVoiceKey(dialogue);
    if (this.activeVoiceScheduled && this.activeVoiceKey === voiceKey) return;

    this.activeVoiceKey = voiceKey;
    this.activeVoiceScheduled = true;

    const scheduleResolvedVoice = (src: string) => {
      if (this.activeDialogueId !== dialogue._id || this.activeVoiceKey !== voiceKey) return;
      const audio = createAudio(src);

      if (dialogue.speakerId && dialogue.lipSync !== 'none') {
        this.lipSync.startAudioDrivenLipSync(dialogue.speakerId, audio);
      }

      scheduleVoice(voiceKey, audio, dialogue.startTime, dialogue.duration || 5);
    };

    const resolved = resolvePath(dialogue.voice);
    if (typeof (resolved as Promise<string>).then === 'function') {
      void (resolved as Promise<string>)
        .then(scheduleResolvedVoice)
        .catch(() => {
          if (this.activeVoiceKey === voiceKey) {
            this.activeVoiceScheduled = false;
          }
        });
    } else {
      scheduleResolvedVoice(resolved as string);
    }
  }

  getActiveDialogueId(): string | null {
    return this.activeDialogueId;
  }

  getActiveDialogueStartTime(): number {
    return this.activeDialogueStartTime;
  }

  reset(): void {
    this.activeDialogueId = null;
    this.activeDialogueStartTime = 0;
    this.activeSpeakerId = null;
    this.activeVoiceKey = null;
    this.activeVoiceScheduled = false;
  }
}
