/**
 * @deprecated Lens filter statements are no longer authorable from the UI.
 * Keep this compatibility validator for historical scene documents.
 */
import type {
  CurrentSceneDocument,
  FilterAddParams,
  FilterChangeParams,
  SceneStatement,
} from '../../api/types/semantic-scene';
import type { LensStyleSlot, SlotRecipeState } from '../../api/types/visual';
import { getLensFilterCategory } from '../../engine/visual-runtime/BuiltInVisualRecipeCatalog';

export interface LensFilterValidationIssue {
  readonly statementId: string;
  readonly type: SceneStatement['type'];
  readonly message: string;
}

type ActiveLensFilters = Map<LensFilterCategory, string>;
type LensFilterCategory = LensStyleSlot;

export interface ActiveLensFilter {
  readonly category: LensFilterCategory;
  readonly recipeId: string;
}

/**
 * @deprecated Compatibility resolver for historical lens filter statements.
 * Resolve the filter choices visible immediately before a statement is edited
 * or inserted. The statement order is the source of truth, including ties.
 */
export function resolveActiveLensFiltersAtTime(
  document: CurrentSceneDocument,
  time: number,
  beforeStatementId?: string,
): ActiveLensFilter[] {
  const active: ActiveLensFilters = new Map();
  let activeSegmentId = resolveSegmentId(document, time);
  seedBaseline(document, activeSegmentId, active);

  const orderedStatements = document.statements
    .map((statement, index) => ({ statement, index }))
    .sort((left, right) => left.statement.time - right.statement.time || left.index - right.index);

  for (const { statement } of orderedStatements) {
    if (statement.time > time) break;
    if (statement.id === beforeStatementId) break;

    const segmentId = resolveSegmentId(document, statement.time);
    if (segmentId !== activeSegmentId) {
      active.clear();
      seedBaseline(document, segmentId, active);
      activeSegmentId = segmentId;
    }

    switch (statement.type) {
      case 'filterAdd': {
        const category = getLensFilterCategory(document.visual, statement.params.recipeId);
        if (category) active.set(category, statement.params.recipeId);
        break;
      }
      case 'filterChange': {
        const fromCategory = findActiveCategory(active, statement.params.fromRecipeId);
        const targetCategory = getLensFilterCategory(document.visual, statement.params.recipeId);
        if (fromCategory && targetCategory) {
          active.delete(fromCategory);
          active.set(targetCategory, statement.params.recipeId);
        }
        break;
      }
      case 'filterReset':
        active.clear();
        seedBaseline(document, segmentId, active);
        break;
      default:
        break;
    }
  }

  return [...active.entries()].map(([category, recipeId]) => ({ category, recipeId }));
}

/** @deprecated Validate historical lens filter statements during compatibility checks. */
export function validateLensFilterStatements(
  document: CurrentSceneDocument,
): LensFilterValidationIssue[] {
  const issues: LensFilterValidationIssue[] = [];
  const active: ActiveLensFilters = new Map();
  let activeSegmentId: string | undefined;

  const orderedStatements = document.statements
    .map((statement, index) => ({ statement, index }))
    .sort((left, right) => left.statement.time - right.statement.time || left.index - right.index);

  for (const { statement } of orderedStatements) {
    const segment = resolveSegmentId(document, statement.time);
    if (segment !== activeSegmentId) {
      active.clear();
      for (const [category, state] of Object.entries(resolveBaseline(document, segment)) as Array<[LensFilterCategory, SlotRecipeState]>) {
        active.set(category, state.recipeId);
      }
      activeSegmentId = segment;
    }

    switch (statement.type) {
      case 'filterAdd':
        validateAdd(document, statement, active, issues);
        break;
      case 'filterChange':
        validateChange(document, statement, active, issues);
        break;
      case 'filterReset':
        active.clear();
        for (const [category, state] of Object.entries(resolveBaseline(document, segment)) as Array<[LensFilterCategory, SlotRecipeState]>) {
          active.set(category, state.recipeId);
        }
        break;
      default:
        break;
    }
  }

  return issues;
}

/** @deprecated Assert compatibility rules for historical lens filter statements. */
export function assertLensFilterStatements(document: CurrentSceneDocument): void {
  const issue = validateLensFilterStatements(document)[0];
  if (issue) throw new Error(issue.message);
}

function validateAdd(
  document: CurrentSceneDocument,
  statement: Extract<SceneStatement, { type: 'filterAdd' }>,
  active: ActiveLensFilters,
  issues: LensFilterValidationIssue[],
): void {
  const params = statement.params as FilterAddParams;
  const category = getLensFilterCategory(document.visual, params.recipeId);
  if (!category) {
    issues.push(issue(statement, `滤镜模板不存在或不属于镜头滤镜：${params.recipeId}`));
    return;
  }
  if (active.has(category)) {
    issues.push(issue(statement, `无法添加滤镜「${params.recipeId}」：${categoryLabel(category)}已有滤镜`));
    return;
  }
  active.set(category, params.recipeId);
}

function validateChange(
  document: CurrentSceneDocument,
  statement: Extract<SceneStatement, { type: 'filterChange' }>,
  active: ActiveLensFilters,
  issues: LensFilterValidationIssue[],
): void {
  const params = statement.params as FilterChangeParams;
  const fromCategory = findActiveCategory(active, params.fromRecipeId);
  if (!fromCategory) {
    issues.push(issue(statement, `无法变化滤镜：当前滤镜不存在「${params.fromRecipeId}」`));
  }

  const targetCategory = getLensFilterCategory(document.visual, params.recipeId);
  if (!targetCategory) {
    issues.push(issue(statement, `滤镜模板不存在或不属于镜头滤镜：${params.recipeId}`));
  }
  if (!fromCategory || !targetCategory) return;

  const existingTarget = active.get(targetCategory);
  if (existingTarget && !sameRecipe(existingTarget, params.fromRecipeId)) {
    issues.push(issue(statement, `无法变化滤镜：${categoryLabel(targetCategory)}已有其他滤镜「${existingTarget}」`));
    return;
  }

  active.delete(fromCategory);
  active.set(targetCategory, params.recipeId);
}

function findActiveCategory(active: ActiveLensFilters, recipeId: string): LensFilterCategory | undefined {
  for (const [category, activeRecipeId] of active) {
    if (sameRecipe(activeRecipeId, recipeId)) return category;
  }
  return undefined;
}

function sameRecipe(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function resolveBaseline(document: CurrentSceneDocument, segmentId: string): Record<string, SlotRecipeState> {
  return document.visual?.segments?.[segmentId]?.lensStyleBaseline ?? {};
}

function seedBaseline(
  document: CurrentSceneDocument,
  segmentId: string,
  active: ActiveLensFilters,
): void {
  for (const [category, state] of Object.entries(resolveBaseline(document, segmentId)) as Array<[LensFilterCategory, SlotRecipeState]>) {
    active.set(category, state.recipeId);
  }
}

function resolveSegmentId(document: CurrentSceneDocument, time: number): string {
  const markers = (document.meta.markers ?? [])
    .filter((marker) => marker.role === 'lens-boundary')
    .sort((left, right) => left.time - right.time || left.markerId.localeCompare(right.markerId));
  let current = 'segment:opening';
  for (const marker of markers) {
    if (marker.time > time) break;
    current = `segment:${marker.markerId}`;
  }
  return current;
}

function categoryLabel(category: LensFilterCategory): string {
  return {
    grade: '色调基底',
    optics: '镜头质感',
    atmosphere: '空气氛围',
    texture: '画面纹理',
  }[category];
}

function issue(
  statement: SceneStatement,
  message: string,
): LensFilterValidationIssue {
  return { statementId: statement.id, type: statement.type, message };
}
