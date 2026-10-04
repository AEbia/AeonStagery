// Dialogue-companion draft model for the Action Inspector (ADR-0022 companion statements).
import { sceneStatementDefinitionRegistry } from '../../../services/semantic-scene';
import type { DialogueCompanionDraft } from '../../../api/types/semantic-scene';

export type DialogueCompanionFamily = 'camera' | 'characterPerformance' | 'visualStyle' | 'audio';

const DIALOGUE_COMPANION_LABELS: Record<DialogueCompanionFamily, string> = {
  camera: '镜头',
  characterPerformance: '角色表演',
  visualStyle: '画面风格',
  audio: '音效',
};

export function characterPerformanceMotionKey(motion: unknown): string | undefined {
  if (!motion || typeof motion !== 'object') return undefined;
  const candidate = motion as { kind?: unknown; key?: unknown };
  if (candidate.kind === 'resource' && typeof candidate.key === 'string') return candidate.key;
  if (candidate.kind === 'custom') {
    const derived = (motion as { derivedFrom?: { key?: unknown } }).derivedFrom;
    return derived && typeof derived.key === 'string' ? derived.key : undefined;
  }
  return undefined;
}

export const dialogueCompanionDefinitions = sceneStatementDefinitionRegistry.list()
  .filter((definition) => definition.attachableTo?.includes('dialogue'))
  .map((definition) => {
    const family = definition.family as DialogueCompanionFamily;
    return { family, label: DIALOGUE_COMPANION_LABELS[family] };
  });

export const dialogueCompanionNeedsCharacterTarget = (family: DialogueCompanionFamily): boolean =>
  family === 'characterPerformance' || family === 'visualStyle';

export const createDialogueCompanionDraft = (
  family: DialogueCompanionFamily,
  speakerId?: string,
  explicitTarget?: string,
): DialogueCompanionDraft | undefined => {
  const target = speakerId ? '$speaker' : explicitTarget;
  switch (family) {
    case 'characterPerformance':
      return target
        ? { anchor: 'start', offset: 0, type: family, params: { target, expression: 'smile' } }
        : undefined;
    case 'visualStyle':
      return target
        ? { anchor: 'start', offset: 0, type: family, params: { scope: 'object', target, slot: 'integration', mode: 'set', recipeId: 'builtin:integration-soft' } }
        : undefined;
    case 'audio':
      return { anchor: 'start', offset: 0, type: family, params: { role: 'sfx', mode: 'play', instanceId: 'dialogue-sfx', file: '', volume: 1 } };
    case 'camera':
      return {
        anchor: 'start',
        offset: 0,
        type: family,
        params: {
          mode: 'focus',
          ...(speakerId ? { target: '$speaker' } : { position: [0.5, 0.5] as [number, number] }),
          zoom: { kind: 'delta', value: 0.15 },
          durationSeconds: 0.6,
        },
      };
  }
};
