import type { CurrentSceneDocument } from '../../api/types/semantic-scene';

/**
 * Collaboration order is a document-layer fact, not a Scene Document JSON
 * field. Keep it attached to materialized source snapshots without allowing
 * it to leak into scene files or the scene schema.
 */
export const SCENE_DOCUMENT_CANONICAL_ORDER = Symbol('sceneDocumentCanonicalOrder');

export type SceneDocumentCanonicalOrderSource = {
  readonly statements: readonly { readonly id: string }[];
};

export type SceneDocumentWithCanonicalOrder<T extends object = CurrentSceneDocument> = T & {
  readonly [SCENE_DOCUMENT_CANONICAL_ORDER]?: readonly string[];
};

export function getSceneDocumentCanonicalOrder(
  document: object | null | undefined,
): readonly string[] | undefined {
  if (!document) return undefined;
  return (document as { readonly [SCENE_DOCUMENT_CANONICAL_ORDER]?: readonly string[] })[
    SCENE_DOCUMENT_CANONICAL_ORDER
  ];
}

/**
 * Preserve an existing order for statements that still exist and place new
 * statements relative to the materialized document order. Existing statement
 * order is never regenerated from time-sorted source arrays.
 */
export function deriveSceneDocumentCanonicalOrder<
  T extends SceneDocumentCanonicalOrderSource = CurrentSceneDocument,
>(
  document: T,
  preferredOrder?: readonly string[],
): readonly string[] {
  const statementIds = document.statements.map((statement) => statement.id);
  if (!preferredOrder) return statementIds;

  const statementIdSet = new Set(statementIds);
  const preservedIds = new Set<string>();
  const preservedOrder = preferredOrder.filter((id) => {
    if (!statementIdSet.has(id) || preservedIds.has(id)) return false;
    preservedIds.add(id);
    return true;
  });
  const result = [...preservedOrder];

  for (const [documentIndex, statementId] of statementIds.entries()) {
    if (preservedIds.has(statementId)) continue;
    const nextPreservedId = statementIds
      .slice(documentIndex + 1)
      .find((candidateId) => preservedIds.has(candidateId));
    const insertionIndex = nextPreservedId === undefined
      ? result.length
      : result.indexOf(nextPreservedId);
    result.splice(insertionIndex, 0, statementId);
    preservedIds.add(statementId);
  }

  return result;
}

/**
 * Attach order to a frozen or unfrozen document by creating a shallow frozen
 * wrapper. The symbol is non-enumerable, so JSON serialization and codec
 * validation continue to see the ordinary current Scene Document shape.
 */
export function withSceneDocumentCanonicalOrder<
  T extends object & SceneDocumentCanonicalOrderSource = CurrentSceneDocument,
>(
  document: T,
  preferredOrder?: readonly string[],
): SceneDocumentWithCanonicalOrder<T> {
  const order = deriveSceneDocumentCanonicalOrder(document, preferredOrder);
  const descriptors = Object.getOwnPropertyDescriptors(document);
  Reflect.deleteProperty(descriptors, SCENE_DOCUMENT_CANONICAL_ORDER);
  const wrapped = Object.create(
    Object.getPrototypeOf(document),
    descriptors,
  ) as SceneDocumentWithCanonicalOrder<T>;
  Object.defineProperty(wrapped, SCENE_DOCUMENT_CANONICAL_ORDER, {
    configurable: false,
    enumerable: false,
    value: Object.freeze([...order]),
    writable: false,
  });
  return Object.freeze(wrapped);
}
