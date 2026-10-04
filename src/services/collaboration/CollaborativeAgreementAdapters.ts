import type {
  CollaborativeSceneStateV2,
  CollaborativeSceneStateV3,
} from '../../api/types/collaboration';
import type {
  HistoricalSceneDocumentV4,
  SceneDocumentV5,
} from '../../api/types/semantic-scene';
import { sceneDocumentCodec } from '../semantic-scene';
import { materializeCollaborativeSceneDocumentV4 } from './CollaborativeSceneStateV2';
import { materializeCollaborativeSceneDocumentV5 } from './CollaborativeSceneStateV3';
import type { CollaborationAssetAgreementProposal } from './CollaborationAssetHandshake';

export interface CollaborativeResourceAgreementRequest {
  proposal: CollaborationAssetAgreementProposal;
  title: string;
  message: string;
}

export interface CollaborativeAgreementPresenter<TRequest> {
  show(request: TRequest): void;
  clear(): void;
}

export class CollaborativeAgreementAdapter<TRequest> {
  private pending: ((confirmed: boolean) => void) | null = null;

  constructor(
    private readonly presenter: CollaborativeAgreementPresenter<TRequest>,
    private readonly cancellationMessage: string,
  ) {}

  request(request: TRequest): Promise<void> {
    this.cancelPending();
    return new Promise<void>((resolve, reject) => {
      this.pending = (confirmed) => {
        this.pending = null;
        if (confirmed) {
          resolve();
          return;
        }
        reject(new Error(this.cancellationMessage));
      };
      this.presenter.show(request);
    });
  }

  complete(confirmed: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.presenter.clear();
    pending(confirmed);
  }

  cancelPending(): void {
    this.complete(false);
  }
}

export class CollaborativeResourceAgreementAdapter extends CollaborativeAgreementAdapter<CollaborativeResourceAgreementRequest> {
  constructor(presenter: CollaborativeAgreementPresenter<CollaborativeResourceAgreementRequest>) {
    super(presenter, '已取消资源约定');
  }
}

export interface CollaborativeFileAccessPort {
  dirname(path: string): Promise<string> | string;
  basename(path: string): Promise<string> | string;
  ensureDir(path: string): Promise<void> | void;
  exists(path: string): Promise<boolean> | boolean;
  copyFile(sourcePath: string, destPath: string): Promise<void> | void;
  writeFile(path: string, data: string): Promise<void> | void;
}

export interface CollaborativeProjectResourcePort {
  resolveForProjectWrite(relativePath: string): Promise<string> | string;
}

export interface CollaborativeServerSceneSafetyPaths {
  jsonBackupPath?: string;
  backupPath?: string;
  targetScenePath: string;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
}

function timestampPathPart(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export interface CollaborativeServerSceneAgreementRequestV2 {
  localDocument: HistoricalSceneDocumentV4 | null;
  serverDocument: HistoricalSceneDocumentV4;
  serverState: CollaborativeSceneStateV2;
  assetAgreementProposal?: CollaborationAssetAgreementProposal;
  blockingIssues: string[];
  jsonBackupPath?: string;
  backupPath?: string;
  targetScenePath: string;
}

export interface CollaborativeServerSceneAgreementOptionsV2 {
  assetAgreementProposal?: CollaborationAssetAgreementProposal;
  blockingIssues?: string[];
}

export interface CollaborativeServerSceneSafetyPathOptionsV2 {
  fileAccess: CollaborativeFileAccessPort;
  projectResources: CollaborativeProjectResourcePort;
  targetSceneRelativePath: string;
  now?: () => Date;
}

export class CollaborativeServerSceneSafetyPathAdapterV2 {
  private readonly fileAccess: CollaborativeFileAccessPort;
  private readonly projectResources: CollaborativeProjectResourcePort;
  private readonly targetSceneRelativePath: string;
  private readonly now: () => Date;

  constructor(options: CollaborativeServerSceneSafetyPathOptionsV2) {
    this.fileAccess = options.fileAccess;
    this.projectResources = options.projectResources;
    this.targetSceneRelativePath = options.targetSceneRelativePath || 'project/main.scene.json';
    this.now = options.now ?? (() => new Date());
  }

  async create(_serverState: CollaborativeSceneStateV2): Promise<CollaborativeServerSceneSafetyPaths> {
    return this.plan();
  }

  async plan(): Promise<CollaborativeServerSceneSafetyPaths> {
    const suffix = timestampPathPart(this.now());
    const targetScenePath = await this.projectResources.resolveForProjectWrite(this.targetSceneRelativePath);
    await this.fileAccess.ensureDir(await this.fileAccess.dirname(targetScenePath));

    if (!(await this.fileAccess.exists(targetScenePath))) return { targetScenePath };
    if (!isJsonScenePath(targetScenePath)) return { targetScenePath };

    const basename = sanitizePathPart(await this.fileAccess.basename(targetScenePath));
    const backupRelativePath = `.aeonstagery/backups/${suffix}/${basename}`;
    const backupPath = await this.projectResources.resolveForProjectWrite(backupRelativePath);
    await this.fileAccess.ensureDir(await this.fileAccess.dirname(backupPath));

    return { backupPath, jsonBackupPath: backupPath, targetScenePath };
  }

  async captureLocalDocument(
    document: HistoricalSceneDocumentV4 | null,
    paths?: CollaborativeServerSceneSafetyPaths,
  ): Promise<CollaborativeServerSceneSafetyPaths> {
    const resolvedPaths = paths ?? await this.plan();
    const backupPath = resolvedPaths.jsonBackupPath ?? resolvedPaths.backupPath;
    if (!backupPath || !(await this.fileAccess.exists(resolvedPaths.targetScenePath))) {
      return resolvedPaths;
    }

    await this.fileAccess.ensureDir(await this.fileAccess.dirname(backupPath));
    if (document) {
      const prepared = sceneDocumentCodec.prepareForSave(document as any);
      await this.fileAccess.writeFile(backupPath, JSON.stringify(prepared, null, 2));
    } else {
      await this.fileAccess.copyFile(resolvedPaths.targetScenePath, backupPath);
    }
    return resolvedPaths;
  }

  async commitServerDocument(
    document: HistoricalSceneDocumentV4,
    paths?: CollaborativeServerSceneSafetyPaths,
  ): Promise<CollaborativeServerSceneSafetyPaths> {
    const resolvedPaths = paths ?? await this.plan();
    await this.fileAccess.ensureDir(await this.fileAccess.dirname(resolvedPaths.targetScenePath));
    const prepared = sceneDocumentCodec.prepareForSave(document as any);
    await this.fileAccess.writeFile(resolvedPaths.targetScenePath, JSON.stringify(prepared, null, 2));
    return resolvedPaths;
  }
}

export interface CollaborativeServerSceneAgreementAdapterOptionsV2 {
  presenter: CollaborativeAgreementPresenter<CollaborativeServerSceneAgreementRequestV2>;
  safetyPaths: CollaborativeServerSceneSafetyPathAdapterV2;
  getLocalDocument: () => HistoricalSceneDocumentV4 | null;
  onAcceptedTargetScenePath?: (targetScenePath: string | undefined) => void;
}

export class CollaborativeServerSceneAgreementAdapterV2 {
  private readonly presenter: CollaborativeAgreementPresenter<CollaborativeServerSceneAgreementRequestV2>;
  private readonly safetyPaths: CollaborativeServerSceneSafetyPathAdapterV2;
  private readonly getLocalDocument: () => HistoricalSceneDocumentV4 | null;
  private readonly onAcceptedTargetScenePath?: (targetScenePath: string | undefined) => void;
  private pending: ((confirmed: boolean) => void) | null = null;
  private accepted = false;
  private acceptedPaths: CollaborativeServerSceneSafetyPaths | null = null;
  private committedAcceptedServerScene = false;

  constructor(options: CollaborativeServerSceneAgreementAdapterOptionsV2) {
    this.presenter = options.presenter;
    this.safetyPaths = options.safetyPaths;
    this.getLocalDocument = options.getLocalDocument;
    this.onAcceptedTargetScenePath = options.onAcceptedTargetScenePath;
  }

  get hasAcceptedServerScene(): boolean {
    return this.accepted;
  }

  reset(): void {
    this.cancelPending();
    this.accepted = false;
    this.acceptedPaths = null;
    this.committedAcceptedServerScene = false;
    this.onAcceptedTargetScenePath?.(undefined);
  }

  async request(
    serverState: CollaborativeSceneStateV2,
    options: CollaborativeServerSceneAgreementOptionsV2 = {},
  ): Promise<void> {
    if (this.accepted) return;
    this.cancelPending();
    const serverDocument = materializeCollaborativeSceneDocumentV4(serverState);
    const paths = await this.safetyPaths.create(serverState);

    await new Promise<void>((resolve, reject) => {
      this.pending = (confirmed) => {
        this.pending = null;
        if (confirmed) {
          void (async () => {
            try {
              if ((options.blockingIssues ?? []).length > 0) {
                throw new Error('资源约定包含阻塞问题，无法覆写本地主剧本');
              }
              this.acceptedPaths = await this.safetyPaths.captureLocalDocument(
                this.getLocalDocument(),
                paths,
              );
              this.committedAcceptedServerScene = false;
              this.onAcceptedTargetScenePath?.(paths.targetScenePath);
              this.accepted = true;
              resolve();
            } catch (error) {
              this.onAcceptedTargetScenePath?.(undefined);
              reject(error);
            }
          })();
          return;
        }
        this.onAcceptedTargetScenePath?.(undefined);
        reject(new Error('已取消服务器语义场景替换'));
      };
      this.presenter.show({
        localDocument: this.getLocalDocument(),
        serverDocument,
        serverState,
        assetAgreementProposal: options.assetAgreementProposal,
        blockingIssues: options.blockingIssues ?? [],
        jsonBackupPath: paths.jsonBackupPath ?? paths.backupPath,
        backupPath: paths.backupPath ?? paths.jsonBackupPath,
        targetScenePath: paths.targetScenePath,
      });
    });
  }

  async commitAcceptedServerDocument(
    document: HistoricalSceneDocumentV4,
  ): Promise<CollaborativeServerSceneSafetyPaths | null> {
    if (!this.accepted || !this.acceptedPaths || this.committedAcceptedServerScene) return null;
    const committedPaths = await this.safetyPaths.commitServerDocument(document, this.acceptedPaths);
    this.acceptedPaths = committedPaths;
    this.committedAcceptedServerScene = true;
    this.onAcceptedTargetScenePath?.(committedPaths.targetScenePath);
    return committedPaths;
  }

  complete(confirmed: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.presenter.clear();
    pending(confirmed);
  }

  cancelPending(): void {
    this.complete(false);
  }
}

export interface CollaborativeServerSceneAgreementRequestV3 {
  localDocument: SceneDocumentV5 | null;
  serverDocument: SceneDocumentV5;
  serverState: CollaborativeSceneStateV3;
  assetAgreementProposal?: CollaborationAssetAgreementProposal;
  blockingIssues: string[];
  jsonBackupPath?: string;
  backupPath?: string;
  targetScenePath: string;
}

export interface CollaborativeServerSceneAgreementOptionsV3 {
  assetAgreementProposal?: CollaborationAssetAgreementProposal;
  blockingIssues?: string[];
}

export interface CollaborativeServerSceneSafetyPathOptionsV3 {
  fileAccess: CollaborativeFileAccessPort;
  projectResources: CollaborativeProjectResourcePort;
  targetSceneRelativePath: string;
  now?: () => Date;
}

export class CollaborativeServerSceneSafetyPathAdapterV3 {
  private readonly fileAccess: CollaborativeFileAccessPort;
  private readonly projectResources: CollaborativeProjectResourcePort;
  private readonly targetSceneRelativePath: string;
  private readonly now: () => Date;

  constructor(options: CollaborativeServerSceneSafetyPathOptionsV3) {
    this.fileAccess = options.fileAccess;
    this.projectResources = options.projectResources;
    this.targetSceneRelativePath = options.targetSceneRelativePath || 'project/main.scene.json';
    this.now = options.now ?? (() => new Date());
  }

  async create(_serverState: CollaborativeSceneStateV3): Promise<CollaborativeServerSceneSafetyPaths> {
    return this.plan();
  }

  async plan(): Promise<CollaborativeServerSceneSafetyPaths> {
    const suffix = timestampPathPart(this.now());
    const targetScenePath = await this.projectResources.resolveForProjectWrite(this.targetSceneRelativePath);
    await this.fileAccess.ensureDir(await this.fileAccess.dirname(targetScenePath));

    if (!(await this.fileAccess.exists(targetScenePath))) return { targetScenePath };
    if (!isJsonScenePath(targetScenePath)) return { targetScenePath };

    const basename = sanitizePathPart(await this.fileAccess.basename(targetScenePath));
    const backupRelativePath = `.aeonstagery/backups/${suffix}/${basename}`;
    const backupPath = await this.projectResources.resolveForProjectWrite(backupRelativePath);
    await this.fileAccess.ensureDir(await this.fileAccess.dirname(backupPath));

    return { backupPath, jsonBackupPath: backupPath, targetScenePath };
  }

  async captureLocalDocument(
    document: SceneDocumentV5 | null,
    paths?: CollaborativeServerSceneSafetyPaths,
  ): Promise<CollaborativeServerSceneSafetyPaths> {
    const resolvedPaths = paths ?? await this.plan();
    const backupPath = resolvedPaths.jsonBackupPath ?? resolvedPaths.backupPath;
    if (!backupPath || !(await this.fileAccess.exists(resolvedPaths.targetScenePath))) {
      return resolvedPaths;
    }

    await this.fileAccess.ensureDir(await this.fileAccess.dirname(backupPath));
    if (document) {
      await this.fileAccess.writeFile(backupPath, JSON.stringify(document, null, 2));
    } else {
      await this.fileAccess.copyFile(resolvedPaths.targetScenePath, backupPath);
    }
    return resolvedPaths;
  }

  async commitServerDocument(
    document: SceneDocumentV5,
    paths?: CollaborativeServerSceneSafetyPaths,
  ): Promise<CollaborativeServerSceneSafetyPaths> {
    const resolvedPaths = paths ?? await this.plan();
    await this.fileAccess.ensureDir(await this.fileAccess.dirname(resolvedPaths.targetScenePath));
    await this.fileAccess.writeFile(resolvedPaths.targetScenePath, JSON.stringify(document, null, 2));
    return resolvedPaths;
  }
}

export interface CollaborativeServerSceneAgreementAdapterOptionsV3 {
  presenter: CollaborativeAgreementPresenter<CollaborativeServerSceneAgreementRequestV3>;
  safetyPaths: CollaborativeServerSceneSafetyPathAdapterV3;
  getLocalDocument: () => SceneDocumentV5 | null;
  onAcceptedTargetScenePath?: (targetScenePath: string | undefined) => void;
}

export class CollaborativeServerSceneAgreementAdapterV3 {
  private readonly presenter: CollaborativeAgreementPresenter<CollaborativeServerSceneAgreementRequestV3>;
  private readonly safetyPaths: CollaborativeServerSceneSafetyPathAdapterV3;
  private readonly getLocalDocument: () => SceneDocumentV5 | null;
  private readonly onAcceptedTargetScenePath?: (targetScenePath: string | undefined) => void;
  private pending: ((confirmed: boolean) => void) | null = null;
  private accepted = false;
  private acceptedPaths: CollaborativeServerSceneSafetyPaths | null = null;
  private committedAcceptedServerScene = false;

  constructor(options: CollaborativeServerSceneAgreementAdapterOptionsV3) {
    this.presenter = options.presenter;
    this.safetyPaths = options.safetyPaths;
    this.getLocalDocument = options.getLocalDocument;
    this.onAcceptedTargetScenePath = options.onAcceptedTargetScenePath;
  }

  get hasAcceptedServerScene(): boolean {
    return this.accepted;
  }

  reset(): void {
    this.cancelPending();
    this.accepted = false;
    this.acceptedPaths = null;
    this.committedAcceptedServerScene = false;
    this.onAcceptedTargetScenePath?.(undefined);
  }

  async request(
    serverState: CollaborativeSceneStateV3,
    options: CollaborativeServerSceneAgreementOptionsV3 = {},
  ): Promise<void> {
    if (this.accepted) return;
    this.cancelPending();
    const serverDocument = materializeCollaborativeSceneDocumentV5(serverState);
    const paths = await this.safetyPaths.create(serverState);

    await new Promise<void>((resolve, reject) => {
      this.pending = (confirmed) => {
        this.pending = null;
        if (confirmed) {
          void (async () => {
            try {
              if ((options.blockingIssues ?? []).length > 0) {
                throw new Error('资源约定包含阻塞问题，无法覆写本地主剧本');
              }
              this.acceptedPaths = await this.safetyPaths.captureLocalDocument(
                this.getLocalDocument(),
                paths,
              );
              this.committedAcceptedServerScene = false;
              this.onAcceptedTargetScenePath?.(paths.targetScenePath);
              this.accepted = true;
              resolve();
            } catch (error) {
              this.onAcceptedTargetScenePath?.(undefined);
              reject(error);
            }
          })();
          return;
        }
        this.onAcceptedTargetScenePath?.(undefined);
        reject(new Error('已取消服务器语义场景替换'));
      };
      this.presenter.show({
        localDocument: this.getLocalDocument(),
        serverDocument,
        serverState,
        assetAgreementProposal: options.assetAgreementProposal,
        blockingIssues: options.blockingIssues ?? [],
        jsonBackupPath: paths.jsonBackupPath ?? paths.backupPath,
        backupPath: paths.backupPath ?? paths.jsonBackupPath,
        targetScenePath: paths.targetScenePath,
      });
    });
  }

  async commitAcceptedServerDocument(
    document: SceneDocumentV5,
  ): Promise<CollaborativeServerSceneSafetyPaths | null> {
    if (!this.accepted || !this.acceptedPaths || this.committedAcceptedServerScene) return null;
    const committedPaths = await this.safetyPaths.commitServerDocument(document, this.acceptedPaths);
    this.acceptedPaths = committedPaths;
    this.committedAcceptedServerScene = true;
    this.onAcceptedTargetScenePath?.(committedPaths.targetScenePath);
    return committedPaths;
  }

  complete(confirmed: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.presenter.clear();
    pending(confirmed);
  }

  cancelPending(): void {
    this.complete(false);
  }
}

function isJsonScenePath(path: string): boolean {
  return path.replace(/\\/g, '/').toLowerCase().endsWith('.json');
}
