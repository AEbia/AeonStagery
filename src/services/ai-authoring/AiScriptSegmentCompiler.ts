import type {
  AiPositionPreset,
  AiRhythmPace,
  AiScriptSegmentPlan,
  AiScriptStep,
} from '../../api/types/ai-authoring';
import type { ScriptSegmentMarkerDraft } from '../../api/types/authoring';
import type {
  CurrentSceneDocument,
  SceneStatementDraft,
} from '../../api/types/semantic-scene';
import {
  PACE_GAP,
  PACE_PAUSE_DURATION,
  resolveDialogueDuration,
} from '../pacing/pacing';

export interface AiScriptSegmentCompileIssue {
  severity: 'error' | 'warning';
  message: string;
  stepIndex?: number;
}

export interface AiScriptSegmentSemanticCompileResult {
  statements: SceneStatementDraft[];
  markers: ScriptSegmentMarkerDraft[];
  issues: AiScriptSegmentCompileIssue[];
  timeRange?: {
    start: number;
    end: number;
  };
  durationSeconds?: number;
}

const POSITION_PRESETS: Record<AiPositionPreset, [number, number]> = {
  left: [0.3, 1],
  leftCenter: [0.4, 1],
  center: [0.5, 1],
  rightCenter: [0.6, 1],
  right: [0.7, 1],
};

const ASSET_PATH_PATTERN = /(?:[a-zA-Z]:[\\/]|(?:^|[\s"'`])(?:\.{1,2}[\\/]|\/)|\b[\w.-]+\.(?:png|jpe?g|webp|gif|json|wmdl|mp3|wav|ogg|mp4|mov|html|css|js)\b)/i;

function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}

function getPace(step: AiScriptStep): AiRhythmPace {
  return step.pace || 'normal';
}
function containsAssetPath(value: string | null | undefined): boolean {
  return !!value && ASSET_PATH_PATTERN.test(value);
}

function collectKnownCharacterIdsFromDocument(document: CurrentSceneDocument): Set<string> {
  return new Set((document.meta.characters || []).map((character) => character.id));
}

function pushPathIssue(
  issues: AiScriptSegmentCompileIssue[],
  value: string | null | undefined,
  stepIndex?: number,
): void {
  if (!containsAssetPath(value)) return;
  issues.push({
    severity: 'error',
    message: 'AI 铺戏结果包含疑似素材或文件路径；第一版不允许 AI 主动选择素材。',
    stepIndex,
  });
}

export function compileAiScriptSegmentPlanToSceneStatements(
  plan: AiScriptSegmentPlan,
  document: CurrentSceneDocument,
): AiScriptSegmentSemanticCompileResult {
  const issues: AiScriptSegmentCompileIssue[] = [];
  const statements: SceneStatementDraft[] = [];
  const markers: ScriptSegmentMarkerDraft[] = [];
  const knownCharacterIds = collectKnownCharacterIdsFromDocument(document);
  let cursor = 0;

  for (const unresolvedName of plan.unresolvedNames) {
    issues.push({
      severity: 'error',
      message: `文本中存在未匹配到现有角色的名字: ${unresolvedName}`,
    });
  }

  pushPathIssue(issues, plan.title);
  pushPathIssue(issues, plan.summary);
  for (const note of plan.notes) {
    pushPathIssue(issues, note);
  }

  plan.steps.forEach((step, stepIndex) => {
    const pace = getPace(step);
    pushPathIssue(issues, step.text, stepIndex);
    pushPathIssue(issues, step.label, stepIndex);

    if (step.characterId && !knownCharacterIds.has(step.characterId)) {
      issues.push({
        severity: 'error',
        message: `步骤 ${stepIndex + 1} 引用了未在 meta.characters 中声明的角色 ID "${step.characterId}"。`,
        stepIndex,
      });
    }

    if (step.kind === 'enter') {
      if (!step.characterId) {
        issues.push({ severity: 'error', message: '登场步骤缺少 characterId。', stepIndex });
        return;
      }
      statements.push({
        time: roundTime(cursor),
        type: 'characterPresence',
        params: {
          mode: 'enter',
          id: step.characterId,
          position: POSITION_PRESETS[step.position || 'center'],
          scale: 1,
          transition: 'fadeIn',
          durationSeconds: 0.8,
        },
      });
      cursor = roundTime(cursor + 0.4);
      return;
    }

    if (step.kind === 'dialogue') {
      const text = step.text?.trim();
      if (!text) {
        issues.push({ severity: 'error', message: '对白步骤缺少 text。', stepIndex });
        return;
      }
      const duration = resolveDialogueDuration({
        context: 'pace-tier',
        text,
        pace,
      });
      statements.push({
        time: roundTime(cursor),
        type: 'dialogue',
        params: {
          text,
          durationSeconds: duration,
          style: 'typewriter',
          ...(step.characterId ? { speakerId: step.characterId } : {}),
        },
      });
      cursor = roundTime(cursor + duration + PACE_GAP[pace]);
      return;
    }

    if (step.kind === 'pause') {
      cursor = roundTime(cursor + PACE_PAUSE_DURATION[pace]);
      return;
    }

    if (step.kind === 'exit') {
      if (!step.characterId) {
        issues.push({ severity: 'error', message: '退场步骤缺少 characterId。', stepIndex });
        return;
      }
      statements.push({
        time: roundTime(cursor),
        type: 'characterPresence',
        params: {
          mode: 'exit',
          id: step.characterId,
          transition: 'fadeOut',
          durationSeconds: 0.6,
        },
      });
      cursor = roundTime(cursor + 0.6);
      return;
    }

    if (step.kind === 'marker') {
      const label = step.label?.trim();
      if (!label) {
        issues.push({ severity: 'error', message: 'Marker 步骤缺少 label。', stepIndex });
        return;
      }
      markers.push({
        offset: roundTime(cursor),
        label,
        role: step.markerRole || 'beat',
      });
    }
  });

  if (statements.length === 0 && markers.length === 0) {
    issues.push({ severity: 'error', message: 'AI 铺戏结果没有生成任何可插入内容。' });
  }

  const end = roundTime(Math.max(
    cursor,
    ...markers.map((marker) => marker.offset),
  ));

  return {
    statements,
    markers,
    issues,
    timeRange: statements.length > 0 || markers.length > 0
      ? { start: 0, end }
      : undefined,
    ...(statements.length > 0 || markers.length > 0 ? { durationSeconds: end } : {}),
  };
}
