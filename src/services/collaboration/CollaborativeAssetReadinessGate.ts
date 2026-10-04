import type {
  CollaborativeAssetManifest,
  ContentHash,
} from '../../api/types/collaboration';
import type {
  HistoricalSceneDocumentV4,
  SceneDocumentV5,
} from '../../api/types/semantic-scene';
import type { ProjectResourceService } from '../io/ProjectResourceService';
import type { IFileAccess } from '../io/IFileAccess';
import {
  browserCollaborativeAssetHashAdapter,
  type LegacyCollaborativeScene,
} from './assets';
import {
  createAssetAgreementProposal,
  getCollaborativeAssetManifestAgreementSignature,
  hasNonReuseAssetAgreementOperations,
  hasServerTransferAssetAgreementOperations,
  shouldPromptForAssetAgreement,
  type CollaborationAssetAgreementFilePlan,
  type CollaborationAssetAgreementItemPlan,
  type CollaborationAssetAgreementProposal,
  type CollaborationAssetAgreementReason,
  type CollaborationAssetHandshakeDirection,
  type CollaborationAssetHandshakeStatus,
} from './CollaborationAssetHandshake';
import type { CollaborativeAssetTransferOptions, CollaborativeAssetTransferProgress } from './CollaborativeAssetTransfer';

export interface CollaborativeAssetReadinessTransferAdapter {
  uploadManifest(manifest: CollaborativeAssetManifest, options?: CollaborativeAssetTransferOptions): Promise<void>;
}

export interface CollaborativeAssetReadinessDownloadAdapter {
  downloadManifest(manifest: CollaborativeAssetManifest, options?: CollaborativeAssetTransferOptions): Promise<void>;
}

export interface CollaborativeAssetReadinessSceneProjectizer {
  prepareCollaborativeAssetReferences(scene: LegacyCollaborativeScene): Promise<LegacyCollaborativeScene>;
  prepareCollaborativeV2SceneDocumentAssetReferences?(document: HistoricalSceneDocumentV4): Promise<HistoricalSceneDocumentV4>;
  prepareCollaborativeV5SceneDocumentAssetReferences?(document: SceneDocumentV5): Promise<SceneDocumentV5>;
}

export interface CollaborativeAssetReadinessManifestBuilder {
  buildForScene(scene: LegacyCollaborativeScene): Promise<CollaborativeAssetManifest>;
  buildForSceneDocumentV4?(document: HistoricalSceneDocumentV4): Promise<CollaborativeAssetManifest>;
  buildForSceneDocumentV5?(document: SceneDocumentV5): Promise<CollaborativeAssetManifest>;
}

export interface CollaborativeAssetReadinessManifestReuseChecker {
  hasUnchangedReferences(
    scene: LegacyCollaborativeScene,
    previousManifest: CollaborativeAssetManifest,
  ): Promise<boolean> | boolean;
  hasUnchangedSceneDocumentV4References?(
    document: HistoricalSceneDocumentV4,
    previousManifest: CollaborativeAssetManifest,
  ): Promise<boolean> | boolean;
  hasUnchangedSceneDocumentV5References?(
    document: SceneDocumentV5,
    previousManifest: CollaborativeAssetManifest,
  ): Promise<boolean> | boolean;
}

export interface CollaborativeAssetReadinessGateOptions {
  fileAccess?: IFileAccess;
  projectResources?: Pick<ProjectResourceService, 'resolveForProjectWrite'> & Partial<Pick<ProjectResourceService, 'resolveForRead'>>;
  sceneProjectizer?: CollaborativeAssetReadinessSceneProjectizer;
  manifestBuilder?: CollaborativeAssetReadinessManifestBuilder;
  manifestReuseChecker?: CollaborativeAssetReadinessManifestReuseChecker;
  uploader: CollaborativeAssetReadinessTransferAdapter;
  downloader: CollaborativeAssetReadinessDownloadAdapter;
  confirmAgreement?: (request: {
    proposal: CollaborationAssetAgreementProposal;
    title: string;
    message: string;
  }) => Promise<void>;
  onHandshake?: (event: {
    manifest?: CollaborativeAssetManifest;
    status: CollaborationAssetHandshakeStatus;
    direction: CollaborationAssetHandshakeDirection;
    error?: string;
    proposal?: CollaborationAssetAgreementProposal;
    transfer?: CollaborativeAssetTransferProgress;
  }) => void;
  onTransferController?: (controller: AbortController | null) => void;
}

export interface CollaborativeAssetReadinessResult {
  signature: string;
  proposal: CollaborationAssetAgreementProposal | null;
  reusedVerifiedSignature: boolean;
}

export interface CollaborativeAssetLocalPublishResult extends CollaborativeAssetReadinessResult {
  scene: LegacyCollaborativeScene;
  assets: CollaborativeAssetManifest;
  reusedPreviousManifest: boolean;
}

export interface CollaborativeAssetLocalPublishResultV3 extends CollaborativeAssetReadinessResult {
  document: HistoricalSceneDocumentV4;
  assets: CollaborativeAssetManifest;
  reusedPreviousManifest: boolean;
}

export interface CollaborativeAssetLocalPublishResultV5 extends CollaborativeAssetReadinessResult {
  document: SceneDocumentV5;
  assets: CollaborativeAssetManifest;
  reusedPreviousManifest: boolean;
}

export interface CollaborativeAssetRemoteApplyResult {
  signature: string | null;
  proposal: CollaborationAssetAgreementProposal | null;
  reusedVerifiedSignature: boolean;
}

export interface CollaborativeAssetReadinessRequest {
  reason: CollaborationAssetAgreementReason;
  baseSignature?: string;
  title: string;
  message: string;
  acceptedProposal?: CollaborationAssetAgreementProposal;
}

function normalizeAbsolutePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeAgreementFilePlans(
  filePlans: CollaborationAssetAgreementFilePlan[],
  direction: CollaborationAssetHandshakeDirection,
): CollaborationAssetAgreementItemPlan {
  const blocking = filePlans.find((plan) => plan.problem?.severity === 'blocking');
  if (blocking) {
    return {
      sourceKind: blocking.sourceKind,
      operation: 'blocked',
      problem: blocking.problem,
      filePlans,
    };
  }

  const warning = filePlans.find((plan) => plan.problem?.severity === 'warning')?.problem;
  const hasOperation = (operation: CollaborationAssetAgreementFilePlan['operation']) => (
    filePlans.some((plan) => plan.operation === operation)
  );

  if (direction === 'local') {
    if (hasOperation('copy-and-upload')) {
      return {
        sourceKind: 'external-library',
        operation: 'copy-and-upload',
        ...(warning ? { problem: warning } : {}),
        filePlans,
      };
    }
    return {
      sourceKind: 'project',
      operation: 'upload',
      ...(warning ? { problem: warning } : {}),
      filePlans,
    };
  }

  if (hasOperation('replace')) {
    return {
      sourceKind: 'server',
      operation: 'replace',
      ...(warning ? { problem: warning } : {}),
      filePlans,
    };
  }
  if (hasOperation('download')) {
    return {
      sourceKind: 'server',
      operation: 'download',
      ...(warning ? { problem: warning } : {}),
      filePlans,
    };
  }
  if (hasOperation('copy')) {
    return {
      sourceKind: 'external-library',
      operation: 'copy',
      ...(warning ? { problem: warning } : {}),
      filePlans,
    };
  }
  return {
    sourceKind: 'project',
    operation: 'reuse',
    ...(warning ? { problem: warning } : {}),
    filePlans,
  };
}

export class CollaborativeAssetReadinessGate {
  private readonly fileAccess?: IFileAccess;
  private readonly projectResources?: Pick<ProjectResourceService, 'resolveForProjectWrite'> & Partial<Pick<ProjectResourceService, 'resolveForRead'>>;
  private readonly sceneProjectizer?: CollaborativeAssetReadinessSceneProjectizer;
  private readonly manifestBuilder?: CollaborativeAssetReadinessManifestBuilder;
  private readonly manifestReuseChecker?: CollaborativeAssetReadinessManifestReuseChecker;
  private readonly uploader: CollaborativeAssetReadinessTransferAdapter;
  private readonly downloader: CollaborativeAssetReadinessDownloadAdapter;
  private readonly confirmAgreement?: CollaborativeAssetReadinessGateOptions['confirmAgreement'];
  private readonly onHandshake?: CollaborativeAssetReadinessGateOptions['onHandshake'];
  private readonly onTransferController?: CollaborativeAssetReadinessGateOptions['onTransferController'];
  private verifiedLocalSignature: string | null = null;
  private verifiedRemoteSignature: string | null = null;
  private activeTransferController: AbortController | null = null;

  constructor(options: CollaborativeAssetReadinessGateOptions) {
    this.fileAccess = options.fileAccess;
    this.projectResources = options.projectResources;
    this.sceneProjectizer = options.sceneProjectizer;
    this.manifestBuilder = options.manifestBuilder;
    this.manifestReuseChecker = options.manifestReuseChecker;
    this.uploader = options.uploader;
    this.downloader = options.downloader;
    this.confirmAgreement = options.confirmAgreement;
    this.onHandshake = options.onHandshake;
    this.onTransferController = options.onTransferController;
  }

  async prepareLocalPublish(input: {
    scene: LegacyCollaborativeScene;
    previousManifest?: CollaborativeAssetManifest;
    reason: CollaborationAssetAgreementReason;
    forceAgreement?: boolean;
    title: string;
    message: string;
  }): Promise<CollaborativeAssetLocalPublishResult> {
    const scene = await this.prepareScene(input.scene);
    if (
      !input.forceAgreement &&
      input.previousManifest &&
      this.manifestReuseChecker &&
      await this.manifestReuseChecker.hasUnchangedReferences(scene, input.previousManifest)
    ) {
      const signature = getCollaborativeAssetManifestAgreementSignature(input.previousManifest);
      return {
        scene,
        assets: input.previousManifest,
        signature,
        proposal: null,
        reusedPreviousManifest: true,
        reusedVerifiedSignature: this.verifiedLocalSignature === signature,
      };
    }

    const manifestBuilder = this.requireManifestBuilder();
    this.emit(undefined, 'checking', 'local');
    const assets = await manifestBuilder.buildForScene(scene);
    this.emit(assets, 'checking', 'local');
    const result = await this.ensureLocalPublishReadiness(assets, {
      reason: input.reason,
      title: input.title,
      message: input.message,
      baseSignature: this.verifiedLocalSignature ?? undefined,
    });
    this.verifiedLocalSignature = result.signature;
    return {
      ...result,
      scene,
      assets,
      reusedPreviousManifest: false,
    };
  }

  async prepareLocalPublishV3(input: {
    document: HistoricalSceneDocumentV4;
    previousManifest?: CollaborativeAssetManifest;
    reason: CollaborationAssetAgreementReason;
    forceAgreement?: boolean;
    title: string;
    message: string;
  }): Promise<CollaborativeAssetLocalPublishResultV3> {
    const document = await this.prepareDocumentV3(input.document);
    if (
      !input.forceAgreement &&
      input.previousManifest &&
      this.manifestReuseChecker?.hasUnchangedSceneDocumentV4References &&
      await this.manifestReuseChecker.hasUnchangedSceneDocumentV4References(document, input.previousManifest)
    ) {
      const signature = getCollaborativeAssetManifestAgreementSignature(input.previousManifest);
      return {
        document,
        assets: input.previousManifest,
        signature,
        proposal: null,
        reusedPreviousManifest: true,
        reusedVerifiedSignature: this.verifiedLocalSignature === signature,
      };
    }

    const manifestBuilder = this.requireManifestBuilderV3();
    this.emit(undefined, 'checking', 'local');
    const assets = await manifestBuilder.buildForSceneDocumentV4(document);
    this.emit(assets, 'checking', 'local');
    const result = await this.ensureLocalPublishReadiness(assets, {
      reason: input.reason,
      title: input.title,
      message: input.message,
      baseSignature: this.verifiedLocalSignature ?? undefined,
    });
    this.verifiedLocalSignature = result.signature;
    return {
      ...result,
      document,
      assets,
      reusedPreviousManifest: false,
    };
  }

  async prepareLocalPublishV5(input: {
    document: SceneDocumentV5;
    previousManifest?: CollaborativeAssetManifest;
    reason: CollaborationAssetAgreementReason;
    forceAgreement?: boolean;
    title: string;
    message: string;
  }): Promise<CollaborativeAssetLocalPublishResultV5> {
    const document = await this.prepareDocumentV5(input.document);
    if (
      !input.forceAgreement &&
      input.previousManifest &&
      this.manifestReuseChecker?.hasUnchangedSceneDocumentV5References &&
      await this.manifestReuseChecker.hasUnchangedSceneDocumentV5References(document, input.previousManifest)
    ) {
      const signature = getCollaborativeAssetManifestAgreementSignature(input.previousManifest);
      return {
        document,
        assets: input.previousManifest,
        signature,
        proposal: null,
        reusedPreviousManifest: true,
        reusedVerifiedSignature: this.verifiedLocalSignature === signature,
      };
    }

    const manifestBuilder = this.requireManifestBuilderV5();
    this.emit(undefined, 'checking', 'local');
    const assets = await manifestBuilder.buildForSceneDocumentV5(document);
    this.emit(assets, 'checking', 'local');
    const result = await this.ensureLocalPublishReadiness(assets, {
      reason: input.reason,
      title: input.title,
      message: input.message,
      baseSignature: this.verifiedLocalSignature ?? undefined,
    });
    this.verifiedLocalSignature = result.signature;
    return {
      ...result,
      document,
      assets,
      reusedPreviousManifest: false,
    };
  }

  async prepareRemoteApply(input: {
    manifest?: CollaborativeAssetManifest;
    reason: CollaborationAssetAgreementReason;
    title: string;
    message: string;
    acceptedProposal?: CollaborationAssetAgreementProposal;
  }): Promise<CollaborativeAssetRemoteApplyResult> {
    const manifest = input.manifest;
    if (!manifest || Object.keys(manifest).length === 0) {
      this.verifiedRemoteSignature = null;
      return { signature: null, proposal: null, reusedVerifiedSignature: false };
    }

    const result = await this.ensureRemoteApplyReadiness(manifest, {
      reason: input.reason,
      title: input.title,
      message: input.message,
      baseSignature: this.verifiedRemoteSignature ?? undefined,
      acceptedProposal: input.acceptedProposal,
    });
    this.verifiedRemoteSignature = result.signature;
    return result;
  }

  reset(scope: 'local' | 'remote' | 'all' = 'all'): void {
    if (scope === 'local' || scope === 'all') this.verifiedLocalSignature = null;
    if (scope === 'remote' || scope === 'all') this.verifiedRemoteSignature = null;
  }

  cancelActiveTransfer(): void {
    this.activeTransferController?.abort();
  }

  async ensureLocalPublishReadiness(
    manifest: CollaborativeAssetManifest,
    request: CollaborativeAssetReadinessRequest,
  ): Promise<CollaborativeAssetReadinessResult> {
    const signature = getCollaborativeAssetManifestAgreementSignature(manifest);
    if (request.baseSignature === signature) {
      this.emit(manifest, 'verified', 'local');
      return { signature, proposal: null, reusedVerifiedSignature: true };
    }

    const proposal = await this.requestAgreement(manifest, 'local', request);
    await this.assertNoBlockingProblems(proposal);
    await this.copyManifestFilesIntoProject(manifest);

    this.emit(manifest, 'uploading', 'local', { proposal });
    const transferAbortController = this.createTransferController();
    try {
      await this.uploader.uploadManifest(manifest, {
        signal: transferAbortController.signal,
        onProgress: (transfer) => {
          this.emit(manifest, 'uploading', 'local', { proposal, transfer });
        },
      });
      this.emit(manifest, 'verified', 'local', { proposal });
      return { signature, proposal, reusedVerifiedSignature: false };
    } catch (error) {
      this.emit(manifest, 'error', 'local', { proposal, error: formatError(error) });
      throw error;
    } finally {
      this.clearTransferController(transferAbortController);
    }
  }

  async ensureRemoteApplyReadiness(
    manifest: CollaborativeAssetManifest,
    request: CollaborativeAssetReadinessRequest,
  ): Promise<CollaborativeAssetReadinessResult> {
    const signature = getCollaborativeAssetManifestAgreementSignature(manifest);
    const proposal = request.acceptedProposal ?? await this.requestAgreement(manifest, 'remote', request);
    this.assertAcceptedProposalMatchesManifest(proposal, signature, 'remote');
    await this.assertNoBlockingProblems(proposal);

    if (request.baseSignature === signature && !hasNonReuseAssetAgreementOperations(proposal.items)) {
      this.emit(manifest, 'verified', 'remote');
      return { signature, proposal: null, reusedVerifiedSignature: true };
    }

    if (!hasNonReuseAssetAgreementOperations(proposal.items)) {
      this.emit(manifest, 'verified', 'remote', { proposal });
      return { signature, proposal, reusedVerifiedSignature: false };
    }

    const transferStatus: CollaborationAssetHandshakeStatus = hasServerTransferAssetAgreementOperations(proposal.items)
      ? 'downloading'
      : 'preparing';
    this.emit(manifest, transferStatus, 'remote', { proposal });
    const transferAbortController = this.createTransferController();
    try {
      await this.downloader.downloadManifest(manifest, {
        signal: transferAbortController.signal,
        onProgress: (transfer) => {
          this.emit(manifest, transferStatus, 'remote', { proposal, transfer });
        },
      });
      this.emit(manifest, 'verified', 'remote', { proposal });
      return { signature, proposal, reusedVerifiedSignature: false };
    } catch (error) {
      this.emit(manifest, 'error', 'remote', { proposal, error: formatError(error) });
      throw error;
    } finally {
      this.clearTransferController(transferAbortController);
    }
  }

  async buildAgreementProposal(
    manifest: CollaborativeAssetManifest,
    direction: CollaborationAssetHandshakeDirection,
    reason: CollaborationAssetAgreementReason,
    baseSignature?: string,
  ): Promise<CollaborationAssetAgreementProposal> {
    if (!this.fileAccess || !this.projectResources) {
      return createAssetAgreementProposal(manifest, direction, { reason, baseSignature });
    }

    const itemPlans: Record<string, CollaborationAssetAgreementItemPlan> = {};
    for (const [assetKey, entry] of Object.entries(manifest)) {
      const filePlans: CollaborationAssetAgreementFilePlan[] = [];

      for (const file of entry.files) {
        const targetPath = await this.projectResources.resolveForProjectWrite(file.relativePath);
        const readablePath = await this.resolveForRead(file.relativePath, targetPath);
        const samePath = normalizeAbsolutePath(readablePath) === normalizeAbsolutePath(targetPath);
        const readableExists = await this.fileAccess.exists(readablePath);
        const targetExists = await this.fileAccess.exists(targetPath);

        if (direction === 'local') {
          if (!readableExists) {
            filePlans.push({
              relativePath: file.relativePath,
              sourceKind: 'unknown',
              operation: 'blocked',
              problem: {
                severity: 'blocking',
                message: '本地找不到这个资源文件，无法发布到协作服务器。',
                filePath: file.relativePath,
              },
            });
          } else if (samePath) {
            filePlans.push({ relativePath: file.relativePath, sourceKind: 'project', operation: 'upload' });
          } else {
            filePlans.push({ relativePath: file.relativePath, sourceKind: 'external-library', operation: 'copy-and-upload' });
          }
          continue;
        }

        const targetMatches = targetExists
          ? await this.hasMatchingManifestFile(targetPath, file.contentHash, file.sizeBytes)
          : false;
        if (targetMatches) {
          filePlans.push({ relativePath: file.relativePath, sourceKind: 'project', operation: 'reuse' });
          continue;
        }

        const readableMatches = readableExists
          ? await this.hasMatchingManifestFile(readablePath, file.contentHash, file.sizeBytes)
          : false;
        if (readableMatches && !samePath) {
          filePlans.push({ relativePath: file.relativePath, sourceKind: 'external-library', operation: 'copy' });
          continue;
        }

        if (targetExists) {
          filePlans.push({
            relativePath: file.relativePath,
            sourceKind: 'server',
            operation: 'replace',
            problem: {
              severity: 'warning',
              message: '项目里已有同路径文件，但内容与服务器资源不同；确认后会写入服务器版本。',
              filePath: file.relativePath,
            },
          });
          continue;
        }

        filePlans.push({ relativePath: file.relativePath, sourceKind: 'server', operation: 'download' });
      }

      itemPlans[assetKey] = mergeAgreementFilePlans(filePlans, direction);
    }

    return createAssetAgreementProposal(manifest, direction, {
      reason,
      baseSignature,
      itemPlans,
    });
  }

  private async requestAgreement(
    manifest: CollaborativeAssetManifest,
    direction: CollaborationAssetHandshakeDirection,
    request: CollaborativeAssetReadinessRequest,
  ): Promise<CollaborationAssetAgreementProposal> {
    const proposal = await this.buildAgreementProposal(
      manifest,
      direction,
      request.reason,
      request.baseSignature,
    );
    if (!shouldPromptForAssetAgreement(proposal)) {
      return proposal;
    }
    this.emit(manifest, 'confirming', direction, { proposal });
    if (!this.confirmAgreement) {
      throw new Error('Resource agreement confirmation adapter is not configured');
    }
    await this.confirmAgreement({
      proposal,
      title: request.title,
      message: request.message,
    });
    return proposal;
  }

  private async copyManifestFilesIntoProject(manifest: CollaborativeAssetManifest): Promise<void> {
    if (!this.fileAccess || !this.projectResources) return;

    for (const entry of Object.values(manifest)) {
      for (const file of entry.files) {
        const sourcePath = await this.resolveForRead(file.relativePath, file.relativePath);
        const targetPath = await this.projectResources.resolveForProjectWrite(file.relativePath);
        if (normalizeAbsolutePath(sourcePath) === normalizeAbsolutePath(targetPath)) continue;
        await this.fileAccess.ensureDir(await this.fileAccess.dirname(targetPath));
        await this.fileAccess.copyFile(sourcePath, targetPath);
      }
    }
  }

  private async resolveForRead(relativePath: string, fallbackPath: string): Promise<string> {
    if (!this.projectResources?.resolveForRead) return fallbackPath;
    try {
      return await this.projectResources.resolveForRead(relativePath);
    } catch {
      return fallbackPath;
    }
  }

  private async hasMatchingManifestFile(
    path: string,
    expectedHash: ContentHash,
    expectedSizeBytes: number,
  ): Promise<boolean> {
    if (!this.fileAccess || !(await this.fileAccess.exists(path))) return false;
    const bytes = await this.readAgreementBytes(path);
    if (bytes.byteLength !== expectedSizeBytes) return false;
    return (await browserCollaborativeAssetHashAdapter.sha256(bytes)) === expectedHash;
  }

  private async readAgreementBytes(path: string): Promise<Uint8Array> {
    if (!this.fileAccess) throw new Error('当前运行环境缺少协作素材读取能力');
    if (this.fileAccess.readBinaryFile) {
      const { data } = await this.fileAccess.readBinaryFile(path);
      return new Uint8Array(data);
    }
    const { data } = await this.fileAccess.readFile(path);
    return new TextEncoder().encode(data);
  }

  private async assertNoBlockingProblems(proposal: CollaborationAssetAgreementProposal): Promise<void> {
    if (proposal.blockingProblemCount === 0) return;
    throw new Error('资源约定包含阻塞问题，无法继续协作资源同步');
  }

  private assertAcceptedProposalMatchesManifest(
    proposal: CollaborationAssetAgreementProposal,
    signature: string,
    direction: CollaborationAssetHandshakeDirection,
  ): void {
    if (proposal.direction !== direction || proposal.proposedSignature !== signature) {
      throw new Error('资源约定与当前协作资源清单不一致，无法继续协作资源同步');
    }
  }

  private async prepareScene(scene: LegacyCollaborativeScene): Promise<LegacyCollaborativeScene> {
    return this.sceneProjectizer?.prepareCollaborativeAssetReferences(scene) ?? scene;
  }

  private async prepareDocumentV3(document: HistoricalSceneDocumentV4): Promise<HistoricalSceneDocumentV4> {
    return this.sceneProjectizer?.prepareCollaborativeV2SceneDocumentAssetReferences?.(document) ?? document;
  }

  private async prepareDocumentV5(document: SceneDocumentV5): Promise<SceneDocumentV5> {
    if (!this.sceneProjectizer) return document;
    if (!this.sceneProjectizer.prepareCollaborativeV5SceneDocumentAssetReferences) {
      // Fail loudly instead of passing @mount references through unpublishable.
      throw new Error('Collaboration scene projectizer is missing V5 asset projectization support');
    }
    return this.sceneProjectizer.prepareCollaborativeV5SceneDocumentAssetReferences(document);
  }

  private requireManifestBuilder(): CollaborativeAssetReadinessManifestBuilder {
    if (!this.manifestBuilder) {
      throw new Error('Collaborative asset manifest builder is not configured');
    }
    return this.manifestBuilder;
  }

  private requireManifestBuilderV3(): Required<Pick<CollaborativeAssetReadinessManifestBuilder, 'buildForSceneDocumentV4'>> {
    if (!this.manifestBuilder?.buildForSceneDocumentV4) {
      throw new Error('Collaborative SceneDocumentV4 asset manifest builder is not configured');
    }
    return this.manifestBuilder as Required<Pick<CollaborativeAssetReadinessManifestBuilder, 'buildForSceneDocumentV4'>>;
  }

  private requireManifestBuilderV5(): Required<Pick<CollaborativeAssetReadinessManifestBuilder, 'buildForSceneDocumentV5'>> {
    if (!this.manifestBuilder?.buildForSceneDocumentV5) {
      throw new Error('Collaborative SceneDocumentV5 asset manifest builder is not configured');
    }
    return this.manifestBuilder as Required<Pick<CollaborativeAssetReadinessManifestBuilder, 'buildForSceneDocumentV5'>>;
  }

  private createTransferController(): AbortController {
    const controller = new AbortController();
    this.activeTransferController = controller;
    this.onTransferController?.(controller);
    return controller;
  }

  private clearTransferController(controller: AbortController): void {
    if (this.activeTransferController !== controller) return;
    this.activeTransferController = null;
    this.onTransferController?.(null);
  }

  private emit(
    manifest: CollaborativeAssetManifest | undefined,
    status: CollaborationAssetHandshakeStatus,
    direction: CollaborationAssetHandshakeDirection,
    options: {
      proposal?: CollaborationAssetAgreementProposal;
      error?: string;
      transfer?: CollaborativeAssetTransferProgress;
    } = {},
  ): void {
    this.onHandshake?.({
      manifest,
      status,
      direction,
      ...options,
    });
  }
}
