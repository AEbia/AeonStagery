import type { CollaborativeAssetManifest, CollaborativeSceneStateV2 } from '../../api/types/collaboration';
import type { HistoricalSceneDocumentV4 } from '../../api/types/semantic-scene';
import {
  createCollaborativeSceneStateV2FromDocument,
} from './CollaborativeSceneStateV2';
import {
  executeCollaborativeStatePublishPlanV2,
  type CollaborativeStatePublishPortsV2,
} from './CollaborativeStatePublishExecutorV2';
import {
  filterTombstonedCollaborativeRecordsV2,
  planCollaborativeStateTransactionV2,
} from './CollaborativeStateTransactionPlannerV2';
import { collectCollaborativeSceneDocumentV4AssetRefs } from './assets';

export type PreparedCollaborativeLocalStateV2 =
  | CollaborativeAssetManifest
  | {
    document: HistoricalSceneDocumentV4;
    assets?: CollaborativeAssetManifest;
  };

export type PrepareCollaborativeLocalStateV2 = (
  document: HistoricalSceneDocumentV4,
  previousState: CollaborativeSceneStateV2,
) => Promise<PreparedCollaborativeLocalStateV2 | undefined> | PreparedCollaborativeLocalStateV2 | undefined;

export type CollaborativeLocalCommitPublisherV2 = CollaborativeStatePublishPortsV2;

export interface CollaborativeLocalCommitPipelineOptionsV2 {
  prepareLocalState?: PrepareCollaborativeLocalStateV2;
}

export interface CollaborativeLocalCommitInputV2 {
  document: HistoricalSceneDocumentV4;
  latestState: CollaborativeSceneStateV2;
  publisher: CollaborativeLocalCommitPublisherV2;
  forcePrepareLocalState?: boolean;
}

function isPreparedLocalDocumentV2(
  value: PreparedCollaborativeLocalStateV2 | undefined,
): value is { document: HistoricalSceneDocumentV4; assets?: CollaborativeAssetManifest } {
  return typeof value === 'object'
    && value !== null
    && 'document' in value
    && typeof (value as { document?: unknown }).document === 'object'
    && (value as { document?: unknown }).document !== null;
}

function getDocumentAssetReferenceSignature(document: HistoricalSceneDocumentV4): string {
  return JSON.stringify(
    collectCollaborativeSceneDocumentV4AssetRefs(document)
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

export class CollaborativeLocalCommitPipelineV2 {
  private readonly prepareLocalState?: PrepareCollaborativeLocalStateV2;

  constructor(options: CollaborativeLocalCommitPipelineOptionsV2 = {}) {
    this.prepareLocalState = options.prepareLocalState;
  }

  async commit(input: CollaborativeLocalCommitInputV2): Promise<CollaborativeSceneStateV2> {
    const latestState = filterTombstonedCollaborativeRecordsV2(input.latestState);
    const shouldPrepareLocalState = input.forcePrepareLocalState
      || getDocumentAssetReferenceSignature(input.document) !== getManifestReferenceSignature(latestState.assets);
    const prepared = shouldPrepareLocalState
      ? await this.prepareLocalState?.(input.document, latestState)
      : undefined;
    const preparedDocument = isPreparedLocalDocumentV2(prepared) ? prepared.document : input.document;
    const assets = isPreparedLocalDocumentV2(prepared) ? prepared.assets : prepared;
    const nextState = filterTombstonedCollaborativeRecordsV2(createCollaborativeSceneStateV2FromDocument(
      preparedDocument,
      {
        collaborationProjectId: latestState.collaborationProjectId,
        roomId: latestState.roomId,
        canonicalStatementOrder: latestState.statementOrder,
        assets: assets ?? latestState.assets,
        tombstones: latestState.tombstones,
      },
    ));
    const plan = planCollaborativeStateTransactionV2(latestState, nextState, {
      statements: !!input.publisher.publishStatementChanges,
      companions: !!input.publisher.publishCompanionChanges,
    });

    return executeCollaborativeStatePublishPlanV2(plan, input.publisher);
  }
}
