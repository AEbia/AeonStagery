import type { CollaborativeSceneStateV3 } from '../../api/types/collaboration';
import type { SceneDocumentV5 } from '../../api/types/semantic-scene';
import type { SemanticDocumentCoordinator } from '../document/SemanticDocumentCoordinator';
import { materializeCollaborativeSceneDocumentV5 } from './CollaborativeSceneStateV3';
import { CollaborationRemoteStateRejectedError } from './CollaborationErrors';

export interface CollaborativeRemoteApplyPipelineV3Options {
  coordinator?: SemanticDocumentCoordinator | { applyDocument: (document: any, path?: string) => Promise<unknown> };
  applyDocument?: (document: SceneDocumentV5, path?: string) => Promise<unknown> | unknown;
  beforeApplyState?: (
    state: CollaborativeSceneStateV3,
    options: { prepareAssets: boolean; requireServerSceneAgreement: boolean },
  ) => Promise<void> | void;
  getApplyScenePath?: (state: CollaborativeSceneStateV3) => string | undefined;
  afterApplyState?: (
    state: CollaborativeSceneStateV3,
    document: SceneDocumentV5,
    path: string | undefined,
  ) => Promise<void> | void;
  onPreparingAssets?: () => void;
  onApplyingStateChange?: (isApplying: boolean) => void;
}

export class CollaborativeRemoteApplyPipelineV3 {
  constructor(private readonly options: CollaborativeRemoteApplyPipelineV3Options) {}

  async applyWithPreparation(
    state: CollaborativeSceneStateV3,
    previousState: CollaborativeSceneStateV3 | null = null,
    options: { prepareAssets?: boolean; requireServerSceneAgreement?: boolean } = {},
  ): Promise<SceneDocumentV5> {
    const shouldPrepareAssets = !sameAssetManifest(previousState, state)
      && Object.keys(state.assets ?? {}).length > 0;
    const prepareAssets = options.prepareAssets ?? shouldPrepareAssets;
    if (prepareAssets) this.options.onPreparingAssets?.();
    await this.options.beforeApplyState?.(state, {
      prepareAssets,
      requireServerSceneAgreement: options.requireServerSceneAgreement ?? true,
    });
    let document: SceneDocumentV5;
    try {
      document = materializeCollaborativeSceneDocumentV5(state);
    } catch (error) {
      throw new CollaborationRemoteStateRejectedError(
        `The remote collaboration screenplay could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    const applyPath = this.options.getApplyScenePath?.(state);
    this.options.onApplyingStateChange?.(true);
    try {
      if (this.options.applyDocument) {
        await this.options.applyDocument(document, applyPath);
      } else if (this.options.coordinator) {
        // coalesce:false — a remote state change must always be projected and
        // stored; it can never be absorbed and dropped by the coordinator's
        // latest-wins batch coalescing of concurrent local commits.
        await (this.options.coordinator as any).applyDocument(document, applyPath, { coalesce: false });
      }
      await this.options.afterApplyState?.(state, document, applyPath);
      return document;
    } finally {
      this.options.onApplyingStateChange?.(false);
    }
  }
}

function sameAssetManifest(
  previous: CollaborativeSceneStateV3 | null,
  next: CollaborativeSceneStateV3,
): boolean {
  return JSON.stringify(previous?.assets ?? {}) === JSON.stringify(next.assets ?? {});
}
