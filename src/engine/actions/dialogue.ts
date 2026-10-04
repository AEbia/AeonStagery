import { subtitleRenderer } from '../SubtitleRenderer';
import type { SchedulerContext } from './types';

export function scheduleDialogue(ctx: SchedulerContext, action: { time?: number; params: Record<string, any> }): void {
  const { tl } = ctx;
  const { time, params } = action;
  const t = time || 0;

  const charMeta = params.speakerId ? ctx.getCharacterMeta(params.speakerId) : undefined;
  const finalSpeaker = params.speakerId && charMeta?.name
    ? charMeta.name
    : params.speaker;
  const finalSpeakerColor = charMeta?.color || params.speakerColor;

  // 1. Dialogue Animation Timeline
  const dialogueTl = subtitleRenderer.showDialogue({
    _id: (action as any)._id || `${params.speaker}_${params.text}_${t}`,
    speaker: finalSpeaker, speakerId: params.speakerId, text: params.text,
    style: params.style ?? 'typewriter', duration: params.duration ?? 3,
    speakerColor: finalSpeakerColor, textColor: params.textColor,
    fontSize: params.fontSize, position: params.position,
    template: params.template,
    presentation: params.presentation,
  });
  tl.add(dialogueTl, t);

  // 2. Lip Sync & Audio
  // Text-driven lip sync is NOT scheduled on the master timeline any more:
  // DialogueCoordinator drives it deterministically on every playback tick
  // via LipSyncEngine.setTextMouthAt (the previous GSAP child timeline was
  // killed at dialogue start and its seek-driven replacement never fired
  // tween onUpdate, so the mouth stayed frozen during playback while the
  // orphan timeline free-ran once pausing stopped the seeks).
}
