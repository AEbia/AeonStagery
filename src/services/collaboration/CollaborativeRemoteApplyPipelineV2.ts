import type { CollaborativeSceneStateV2 } from '../../api/types/collaboration';
import type { HistoricalSceneDocumentV4 } from '../../api/types/semantic-scene';
import type { SemanticDocumentCoordinator } from '../document/SemanticDocumentCoordinator';
import { materializeCollaborativeSceneDocumentV4 } from './CollaborativeSceneStateV2';

export interface CollaborativeRemoteApplyPipelineV2Options {
  coordinator: SemanticDocumentCoordinator;
  beforeApplyState?: (
    state: CollaborativeSceneStateV2,
    options: { prepareAssets: boolean; requireServerSceneAgreement: boolean },
  ) => Promise<void> | void;
  getApplyScenePath?: (state: CollaborativeSceneStateV2) => string | undefined;
  afterApplyState?: (
    state: CollaborativeSceneStateV2,
    document: HistoricalSceneDocumentV4,
    path: string | undefined,
  ) => Promise<void> | void;
  onPreparingAssets?: () => void;
  onApplyingStateChange?: (isApplying: boolean) => void;
}

export class CollaborativeRemoteApplyPipelineV2 {
  constructor(private readonly options: CollaborativeRemoteApplyPipelineV2Options) {}

  async applyWithPreparation(
    state: CollaborativeSceneStateV2,
    previousState: CollaborativeSceneStateV2 | null = null,
    options: { prepareAssets?: boolean; requireServerSceneAgreement?: boolean } = {},
  ): Promise<HistoricalSceneDocumentV4> {
    const shouldPrepareAssets = !sameAssetManifest(previousState, state)
      && Object.keys(state.assets ?? {}).length > 0;
    const prepareAssets = options.prepareAssets ?? shouldPrepareAssets;
    if (prepareAssets) this.options.onPreparingAssets?.();
    await this.options.beforeApplyState?.(state, {
      prepareAssets,
      requireServerSceneAgreement: options.requireServerSceneAgreement ?? true,
    });
    const document = materializeCollaborativeSceneDocumentV4(state);
    const applyPath = this.options.getApplyScenePath?.(state);
    this.options.onApplyingStateChange?.(true);
    try {
      // coalesce:false — a remote state change must always be projected and
      // stored; it can never be absorbed and dropped by the coordinator's
      // latest-wins batch coalescing of concurrent local commits.
      await this.options.coordinator.applyDocument(document as any, applyPath, { coalesce: false });
      await this.options.afterApplyState?.(state, document, applyPath);
      return document;
    } finally {
      this.options.onApplyingStateChange?.(false);
    }
  }
}

function sameAssetManifest(
  previous: CollaborativeSceneStateV2 | null,
  next: CollaborativeSceneStateV2,
): boolean {
  return JSON.stringify(previous?.assets ?? {}) === JSON.stringify(next.assets ?? {});
}
