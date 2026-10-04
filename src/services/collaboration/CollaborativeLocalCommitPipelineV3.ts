import type { CollaborativeAssetManifest, CollaborativeSceneStateV3 } from '../../api/types/collaboration';
import type { SceneDocumentV5 } from '../../api/types/semantic-scene';
import {
  createCollaborativeSceneStateV3FromDocument,
} from './CollaborativeSceneStateV3';
import {
  executeCollaborativeStatePublishPlanV3,
  type CollaborativeStatePublishPortsV3,
} from './CollaborativeStatePublishExecutorV3';
import {
  filterTombstonedCollaborativeRecordsV3,
  planCollaborativeStateTransactionV3,
} from './CollaborativeStateTransactionPlannerV3';
import { collectCollaborativeSceneDocumentV5AssetRefs } from './assets';
import { getSceneDocumentCanonicalOrder } from '../semantic-scene/SceneDocumentCanonicalOrder';

export type PreparedCollaborativeLocalStateV3 =
  | CollaborativeAssetManifest
  | {
    document: SceneDocumentV5;
    assets?: CollaborativeAssetManifest;
  };

export type PrepareCollaborativeLocalStateV3 = (
  document: SceneDocumentV5,
  previousState: CollaborativeSceneStateV3,
) => Promise<PreparedCollaborativeLocalStateV3 | undefined> | PreparedCollaborativeLocalStateV3 | undefined;

export type CollaborativeLocalCommitPublisherV3 = CollaborativeStatePublishPortsV3;

export interface CollaborativeLocalCommitPipelineOptionsV3 {
  prepareLocalState?: PrepareCollaborativeLocalStateV3;
}

export interface CollaborativeLocalCommitInputV3 {
  document: SceneDocumentV5;
  latestState: CollaborativeSceneStateV3;
  publisher: CollaborativeLocalCommitPublisherV3;
  forcePrepareLocalState?: boolean;
}

function isPreparedLocalDocumentV3(
  value: PreparedCollaborativeLocalStateV3 | undefined,
): value is { document: SceneDocumentV5; assets?: CollaborativeAssetManifest } {
  return typeof value === 'object'
    && value !== null
    && 'document' in value
    && typeof (value as { document?: unknown }).document === 'object'
    && (value as { document?: unknown }).document !== null;
}

function getDocumentAssetReferenceSignature(document: SceneDocumentV5): string {
  return JSON.stringify(
    collectCollaborativeSceneDocumentV5AssetRefs(document)
      .map((ref) => ({
        kind: ref.kind,
        importKind: ref.importKind,
        projectRelativePath: ref.projectRelativePath,
      }))
      .sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath)),
  );
}

function getManifestReferenceSignature(manifest: CollaborativeAssetManifest | undefined): string {
  return JSON.stringify(
    Object.values(manifest ?? {})
      .map((entry) => ({
        kind: entry.kind,
        importKind: entry.importKind,
        projectRelativePath: entry.projectRelativePath,
      }))
      .sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath)),
  );
}

export class CollaborativeLocalCommitPipelineV3 {
  private readonly prepareLocalState?: PrepareCollaborativeLocalStateV3;

  constructor(options: CollaborativeLocalCommitPipelineOptionsV3 = {}) {
    this.prepareLocalState = options.prepareLocalState;
  }

  async commit(input: CollaborativeLocalCommitInputV3): Promise<CollaborativeSceneStateV3> {
    const latestState = filterTombstonedCollaborativeRecordsV3(input.latestState);
    // Asset preparation may clone the document and drop this non-enumerable
    // metadata, so capture an explicit authoring order before preparing it.
    const canonicalStatementOrder = getSceneDocumentCanonicalOrder(input.document)
      ?? latestState.statementOrder;
    const shouldPrepareLocalState = input.forcePrepareLocalState
      || getDocumentAssetReferenceSignature(input.document) !== getManifestReferenceSignature(latestState.assets);
    const prepared = shouldPrepareLocalState
      ? await this.prepareLocalState?.(input.document, latestState)
      : undefined;
    const preparedDocument = isPreparedLocalDocumentV3(prepared) ? prepared.document : input.document;
    const assets = isPreparedLocalDocumentV3(prepared) ? prepared.assets : prepared;
    const nextState = filterTombstonedCollaborativeRecordsV3(createCollaborativeSceneStateV3FromDocument(
      preparedDocument,
      {
        collaborationProjectId: latestState.collaborationProjectId,
        roomId: latestState.roomId,
        canonicalStatementOrder,
        assets: assets ?? latestState.assets,
        tombstones: latestState.tombstones,
      },
    ));
    const plan = planCollaborativeStateTransactionV3(latestState, nextState, {
      statements: !!input.publisher.publishStatementChanges,
      companions: !!input.publisher.publishCompanionChanges,
    });

    return executeCollaborativeStatePublishPlanV3(plan, input.publisher);
  }
}
