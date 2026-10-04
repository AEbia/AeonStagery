import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import { SemanticSceneLineView } from '../semantic-scene/SemanticSceneLineView';
import type { EnhancementStageKind } from './CinematicEnhancementPolicy';
import { getEnhancementStagePolicyVersion } from './CinematicEnhancementPolicy';
import {
  buildFormalStatementGroups,
  type FormalStatementGroupV1,
} from './FormalSceneEnhancementHost';
import {
  buildEnhancementStageScope,
  DEFAULT_MAX_VISIBLE_CHARS_PER_UNIT,
  type EnhancementStageScopeV1,
  type TechnicalSplitUnitV1,
} from './EnhancementScope';
import {
  CINEMATIC_LINE_FAMILIES,
  projectCinematicLineView,
  projectCompactLine,
  projectFormalSceneStoryText,
  projectPerformanceLineView,
} from './SceneLineProjection';
import {
  buildPerformanceCapabilityCatalog,
  type PerformanceProfileProvider,
} from './performance';
import {
  buildCinematicCapabilityCatalog,
  type CinematicCapabilityPort,
} from './CinematicCapabilityCatalog';
import type { ModelCapabilityPort } from './EnhancementProcessorRunner';

export const PERFORMANCE_PROCESSOR_VERSION = 'performance-processor/v2' as const;
export const CINEMATIC_PROCESSOR_VERSION = 'cinematic-processor/v2' as const;

/**
 * Char budget for read-only context lines surrounding a unit's core in the
 * model-facing line view. Only context lines count against it; core lines are
 * always fully present. Matches the story-text budget (`maxVisibleCharsPerUnit`)
 * so the line view scales with the unit instead of the whole scene.
 */
export const DEFAULT_LINE_VIEW_CONTEXT_CHARS = DEFAULT_MAX_VISIBLE_CHARS_PER_UNIT;

/**
 * Deterministic unit-scoped line selection for the processor line view: every
 * core writable line plus a bounded read-only context around it. Without this,
 * every unit of a long scene received the whole document's line view, making
 * input tokens grow ~10x the story text.
 *
 * Budget accounting bills the exact emitted payload: lines are measured with
 * the same `projectCompactLine` shape the projection emits (presentation
 * fields and dialogue text dropped), and lines dropped by the stage family
 * filter cost nothing. Roots are selected atomically with their companions,
 * matching the projection's companion closure, so the emitted view never
 * exceeds the budget and never references a missing parent. Expansion walks
 * the flat view outward from the core block (forward first, then backward)
 * and stops when the context char budget is exhausted. The same document +
 * scope + stage + budget always yields the same set, so runner, fingerprint
 * and restore replay agree.
 */
export function scopeUnitLineViewFilter(input: {
  readonly document: CurrentSceneDocument;
  readonly scope: EnhancementStageScopeV1;
  readonly stage: EnhancementStageKind;
  readonly maxContextChars: number;
}): ReadonlySet<number> {
  const lines = new SemanticSceneLineView(input.document).lines;
  const familyFilter = input.stage === 'cinematic'
    ? new Set<string>(CINEMATIC_LINE_FAMILIES)
    : undefined;
  const companionsByParent = new Map<number, number[]>();
  for (const line of lines) {
    if (line.kind === 'companion' && line.parentLine !== undefined) {
      const group = companionsByParent.get(line.parentLine);
      if (group) group.push(line.line);
      else companionsByParent.set(line.parentLine, [line.line]);
    }
  }

  const included = new Set<number>(input.scope.writableLines);
  let firstCoreIndex = -1;
  let lastCoreIndex = -1;
  let contextCost = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (input.scope.writableRootLines.has(lines[index]!.line)) {
      if (firstCoreIndex < 0) firstCoreIndex = index;
      lastCoreIndex = index;
    }
  }
  if (firstCoreIndex < 0) return included;

  const lineCost = (line: (typeof lines)[number]): number => {
    if (familyFilter && !familyFilter.has(line.type)) return 0;
    return JSON.stringify(projectCompactLine(line, { omitDialogueText: true })).length;
  };
  const groupCost = (root: (typeof lines)[number]): number => {
    let cost = lineCost(root);
    for (const companionLine of companionsByParent.get(root.line) ?? []) {
      cost += lineCost(lines[companionLine - 1]!);
    }
    return cost;
  };
  const addGroup = (root: (typeof lines)[number]): number => {
    const cost = groupCost(root);
    if (contextCost + cost > input.maxContextChars) return 0;
    included.add(root.line);
    for (const companionLine of companionsByParent.get(root.line) ?? []) {
      included.add(companionLine);
    }
    contextCost += cost;
    return cost;
  };

  for (let index = lastCoreIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (included.has(line.line)) continue;
    if (line.kind === 'companion') break;
    if (addGroup(line) === 0) break;
  }
  for (let index = firstCoreIndex - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (included.has(line.line)) continue;
    if (line.kind === 'companion') continue;
    addGroup(line);
  }

  return included;
}

export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilityPort = {
  motionsForCharacter: () => [],
  expressionsForCharacter: () => [],
  hasModelConfigured: () => false,
};

/**
 * Pure unit-scope resolution shared by the processor runner (run time) and the
 * draft restore replay (restore time), so fingerprints are computed identically.
 */
export function resolveEnhancementUnitScope(input: {
  readonly document: CurrentSceneDocument;
  readonly groups: readonly FormalStatementGroupV1[];
  readonly unit: TechnicalSplitUnitV1;
  readonly unitIndex: number;
  readonly totalUnits: number;
  readonly rescopeByTime?: boolean;
  readonly originalGroups?: readonly FormalStatementGroupV1[];
}): EnhancementStageScopeV1 {
  let startGroupIndex = input.unit.startGroupIndex;
  let endGroupIndexExclusive = input.unit.endGroupIndexExclusive;
  const groups = input.groups;

  if (input.rescopeByTime && input.originalGroups) {
    const originalStart = input.originalGroups[input.unit.startGroupIndex];
    const originalEndExclusive = input.unit.endGroupIndexExclusive < input.originalGroups.length
      ? input.originalGroups[input.unit.endGroupIndexExclusive]
      : undefined;
    if (originalStart) {
      const mappedStart = groups.findIndex((group) => group.time >= originalStart.time);
      startGroupIndex = mappedStart >= 0 ? mappedStart : 0;
      if (originalEndExclusive) {
        const mappedEnd = groups.findIndex((group) => group.time >= originalEndExclusive.time);
        endGroupIndexExclusive = mappedEnd >= 0 ? mappedEnd : groups.length;
      } else {
        endGroupIndexExclusive = groups.length;
      }
    }
  }

  // Clamp
  startGroupIndex = Math.max(0, Math.min(startGroupIndex, groups.length));
  endGroupIndexExclusive = Math.max(startGroupIndex, Math.min(endGroupIndexExclusive, groups.length));

  const isLastUnit = input.unitIndex === input.totalUnits - 1
    || endGroupIndexExclusive >= groups.length;
  const nextUnitStartTime = !isLastUnit && endGroupIndexExclusive < groups.length
    ? groups[endGroupIndexExclusive]!.time
    : undefined;

  return buildEnhancementStageScope({
    document: input.document,
    groups,
    boundary: {
      key: input.unit.key,
      startGroupIndex,
      endGroupIndexExclusive,
    },
    isLastUnit,
    nextUnitStartTime,
    unitKey: input.unit.key,
  });
}

/**
 * Performance capability catalog for one unit from the document character
 * directory, intersected with the configured model capability port. Shared by
 * the runner (prompt + fingerprint) and the restore replay (fingerprint).
 */
export function buildPerformanceCapabilityCatalogForDocument(input: {
  readonly document: CurrentSceneDocument;
  readonly modelCapabilities?: ModelCapabilityPort;
  readonly profileProvider?: PerformanceProfileProvider | null;
}) {
  const capabilities = input.modelCapabilities ?? DEFAULT_MODEL_CAPABILITIES;
  const characters = (input.document.meta.characters ?? []).map((character) => {
    const hasModel = capabilities.hasModelConfigured(character.id);
    return {
      identity: {
        id: character.id,
        name: character.name,
      },
      motions: hasModel ? capabilities.motionsForCharacter(character.id) : [],
      expressions: hasModel ? capabilities.expressionsForCharacter(character.id) : [],
      fieldLevelDegrade: !hasModel,
    };
  });
  const lookAtTargets = characters.map((entry) => entry.identity.id);
  return buildPerformanceCapabilityCatalog({
    characters,
    lookAtTargets,
    reactionTargets: lookAtTargets,
    provider: input.profileProvider,
  });
}

/**
 * Pure recomputation of the unit input fingerprint from the same inputs the
 * processor runner used at run time (single source of truth: the runner stores
 * exactly what this function returns, and restore replay recomputes it).
 */
export function buildEnhancementUnitInputFingerprint(input: {
  readonly document: CurrentSceneDocument;
  readonly stage: EnhancementStageKind;
  readonly unit: TechnicalSplitUnitV1;
  readonly unitIndex: number;
  readonly totalUnits: number;
  readonly modelCapabilities?: ModelCapabilityPort;
  readonly profileProvider?: PerformanceProfileProvider | null;
  readonly cinematicCapabilities?: CinematicCapabilityPort;
  readonly rescopeByTime?: boolean;
  readonly originalGroups?: readonly FormalStatementGroupV1[];
  /** Read-only context budget for the unit line view. Defaults to DEFAULT_LINE_VIEW_CONTEXT_CHARS. */
  readonly maxLineViewContextChars?: number;
}): string {
  const scope = resolveEnhancementUnitScope({
    document: input.document,
    groups: buildFormalStatementGroups(input.document),
    unit: input.unit,
    unitIndex: input.unitIndex,
    totalUnits: input.totalUnits,
    rescopeByTime: input.rescopeByTime,
    originalGroups: input.originalGroups,
  });
  const storyText = projectFormalSceneStoryText(input.document, {
    lineFilter: scope.writableRootLines,
  });
  const lineFilter = scopeUnitLineViewFilter({
    document: input.document,
    scope,
    stage: input.stage,
    maxContextChars: input.maxLineViewContextChars ?? DEFAULT_LINE_VIEW_CONTEXT_CHARS,
  });
  const compactLineView = input.stage === 'performance'
    ? projectPerformanceLineView(input.document, {
      writableLines: scope.writableLines,
      lineFilter,
    })
    : projectCinematicLineView(input.document, {
      writableLines: scope.writableLines,
      lineFilter,
    });
  const catalog = input.stage === 'performance'
    ? buildPerformanceCapabilityCatalogForDocument({
      document: input.document,
      modelCapabilities: input.modelCapabilities,
      profileProvider: input.profileProvider,
    })
    : buildCinematicCapabilityCatalog({
      document: input.document,
      unitStartTime: scope.coreStartTime,
      capabilities: input.cinematicCapabilities,
    });

  return fingerprintEnhancementUnitInput({
    unitKey: input.unit.key,
    stage: input.stage,
    policyVersion: getEnhancementStagePolicyVersion(input.stage),
    processorVersion: input.stage === 'performance'
      ? PERFORMANCE_PROCESSOR_VERSION
      : CINEMATIC_PROCESSOR_VERSION,
    storyText,
    lineView: compactLineView,
    catalog,
  });
}

/** Stable short fingerprint of unit inputs for checkpoint invalidation / UI. */
export function fingerprintEnhancementUnitInput(input: {
  readonly unitKey: string;
  readonly stage: EnhancementStageKind;
  readonly policyVersion: string;
  readonly processorVersion: string;
  readonly storyText: string;
  readonly lineView: unknown;
  readonly catalog: unknown;
}): string {
  const payload = JSON.stringify({
    unitKey: input.unitKey,
    stage: input.stage,
    policyVersion: input.policyVersion,
    processorVersion: input.processorVersion,
    storyText: input.storyText,
    lineView: input.lineView,
    catalog: input.catalog,
  });
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  // 32-bit FNV-1a expanded to 16 hex chars via second pass over length.
  const mixed = (hash ^ payload.length) >>> 0;
  return `${hash.toString(16).padStart(8, '0')}${mixed.toString(16).padStart(8, '0')}`;
}
