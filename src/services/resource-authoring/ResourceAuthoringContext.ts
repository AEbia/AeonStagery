import type { CurrentSceneDocument } from '../../api/types/semantic-scene';
import type { ResourceResolutionContext } from './ResourceAuthoringTypes';

export interface ResourceAuthoringScope {
  readonly kind: ResourceResolutionContext['kind'];
  readonly time: number;
  readonly ownerId?: string;
  readonly outfitId?: string;
}

/** Completes authoring context from canonical source facts; never used by compilation/runtime. */
export function completeResourceAuthoringContext(
  document: CurrentSceneDocument,
  scope: ResourceAuthoringScope,
): ResourceResolutionContext {
  const ownerId = scope.ownerId;
  if (!ownerId || scope.outfitId) return compactContext(scope.kind, ownerId, scope.outfitId);

  let outfitId: string | undefined;
  for (const statement of document.statements) {
    if (statement.time > scope.time) break;
    if (statement.type !== 'characterPresence' || statement.params.id !== ownerId) continue;
    if (statement.params.mode === 'exit') {
      outfitId = undefined;
      continue;
    }
    outfitId = statement.params.variant?.trim() || inferOutfitFromModel(statement.params.model);
  }
  return compactContext(scope.kind, ownerId, outfitId);
}

function compactContext(
  kind: ResourceResolutionContext['kind'],
  ownerId?: string,
  outfitId?: string,
): ResourceResolutionContext {
  return { kind, ...(ownerId ? { ownerId } : {}), ...(outfitId ? { outfitId } : {}) };
}

function inferOutfitFromModel(model?: string): string | undefined {
  if (!model) return undefined;
  const parts = model.replace(/\\/g, '/').split('/').filter(Boolean);
  const modelsIndex = parts.lastIndexOf('models');
  return modelsIndex >= 0 ? parts[modelsIndex + 1] : undefined;
}
