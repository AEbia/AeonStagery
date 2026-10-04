import {
  SCENE_SCHEMA_VERSION_V5,
} from '../../api/types/semantic-scene';
import { SceneDocumentCodec, sceneDocumentCodec } from './SceneDocumentCodec';
import {
  CompatibleSceneSession,
  type SceneCompatibilityIssue,
  type SceneMigrationStage,
} from './CompatibleSceneSession';
import {
  CompatibilityCoordinator,
  SceneArtifactCompatibilityAdapter,
  type CoordinatorBackupResolverPort,
  type CoordinatorFileAccessPort,
  type MigrationConfirmationRequest,
} from '../compatibility';

export type SceneMigrationFileAccessPort = CoordinatorFileAccessPort;
export type SceneMigrationProjectResourcePort = CoordinatorBackupResolverPort;

export interface SceneMigrationConfirmationPresenter {
  show(request: SceneMigrationConfirmationRequest): void;
  clear(): void;
}

export class SceneMigrationConfirmationAdapter {
  private pending: ((confirmed: boolean) => void) | null = null;

  constructor(
    private readonly presenter: SceneMigrationConfirmationPresenter,
  ) {}

  request(request: MigrationConfirmationRequest): Promise<boolean> {
    this.cancelPending();
    return new Promise<boolean>((resolve) => {
      this.pending = (confirmed) => {
        this.pending = null;
        resolve(confirmed);
      };
      const sceneRequest: SceneMigrationConfirmationRequest = {
        ...request,
        scenePath: request.scenePath ?? request.artifactPath ?? '',
        targetEpoch: (request.targetEpoch as typeof SCENE_SCHEMA_VERSION_V5),
        stages: (request.stages as readonly SceneMigrationStage[]),
      };
      this.presenter.show(sceneRequest);
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

export interface SceneMigrationConfirmationRequest extends MigrationConfirmationRequest {
  readonly scenePath: string;
  readonly backupPath: string;
  readonly sourceEpoch: number;
  readonly targetEpoch: typeof SCENE_SCHEMA_VERSION_V5;
  readonly stages: readonly SceneMigrationStage[];
  readonly warnings: readonly string[];
}

/**
 * A presenter hoist that lets the React layer (or any other host) attach the
 * active confirmation handler after the experience is constructed outside the
 * UI, e.g. during Bootstrap. `SceneMigrationExperience` owns one of these and
 * the app registers a handler so `SceneMigrationConfirmationDialog` is the
 * actual presenter driving the pending migration confirmation.
 */
export class SceneMigrationConfirmationPresenterHost implements SceneMigrationConfirmationPresenter {
  private handler: SceneMigrationConfirmationPresenter | null = null;
  private pendingRequest: SceneMigrationConfirmationRequest | null = null;

  setHandler(handler: SceneMigrationConfirmationPresenter | null): void {
    this.handler = handler;
    if (handler && this.pendingRequest) {
      const request = this.pendingRequest;
      this.pendingRequest = null;
      handler.show(request);
    }
  }

  show(request: SceneMigrationConfirmationRequest): void {
    if (this.handler) {
      this.handler.show(request);
      return;
    }
    this.pendingRequest = request;
  }

  clear(): void {
    this.handler?.clear();
    this.pendingRequest = null;
  }
}

export interface SceneMigrationExperienceOptions {
  readonly fileAccess: SceneMigrationFileAccessPort;
  readonly projectResources?: SceneMigrationProjectResourcePort;
  readonly confirmationPresenter?: SceneMigrationConfirmationPresenter;
  readonly confirmMigration?: (request: SceneMigrationConfirmationRequest) => Promise<boolean>;
  readonly codec?: SceneDocumentCodec;
  readonly now?: () => Date;
}

export type SceneMigrationOutcome =
  | {
      readonly status: 'ready';
      readonly session: CompatibleSceneSession;
      readonly migrated: false;
      readonly path: string;
    }
  | {
      readonly status: 'migrated';
      readonly session: CompatibleSceneSession;
      readonly migrated: true;
      readonly path: string;
      readonly backupPath: string;
      readonly warnings: readonly string[];
      readonly sourceEpoch: number;
      readonly targetEpoch: number;
    }
  | {
      readonly status: 'cancelled';
      readonly path: string;
      readonly reason: 'declined' | 'user_cancelled';
    }
  | {
      readonly status: 'incompatible';
      readonly path: string;
      readonly issue: SceneCompatibilityIssue;
    }
  | {
      readonly status: 'invalid';
      readonly path: string;
      readonly issue: SceneCompatibilityIssue;
    };

export class SceneMigrationExperience {
  private readonly coordinator: CompatibilityCoordinator;
  private readonly adapter: SceneArtifactCompatibilityAdapter;
  private readonly confirmationAdapter?: SceneMigrationConfirmationAdapter;
  readonly presenterHost: SceneMigrationConfirmationPresenterHost;

  constructor(options: SceneMigrationExperienceOptions) {
    this.adapter = new SceneArtifactCompatibilityAdapter(options.codec ?? sceneDocumentCodec);
    this.presenterHost = new SceneMigrationConfirmationPresenterHost();
    if (options.confirmationPresenter) {
      const upstream = options.confirmationPresenter;
      this.presenterHost.setHandler({
        show: (request) => upstream.show(request),
        clear: () => upstream.clear(),
      });
    }
    // Only wire a live confirmation adapter when there is a presenter (React)
    // or an explicit migration callback. Without either, marshalling defaults
    // to the coordinator's old behavior: gated migration auto-cancels instead
    // of hanging on a promise nobody will settle.
    if (options.confirmationPresenter || options.confirmMigration) {
      this.confirmationAdapter = new SceneMigrationConfirmationAdapter(this.presenterHost);
    }
    this.coordinator = new CompatibilityCoordinator({
      fileAccess: options.fileAccess,
      backupResolver: options.projectResources,
      confirmMigration: options.confirmMigration
        ? (req) => options.confirmMigration!({
            ...req,
            scenePath: req.scenePath ?? req.artifactPath ?? '',
            targetEpoch: (req.targetEpoch as typeof SCENE_SCHEMA_VERSION_V5),
            stages: (req.stages as readonly SceneMigrationStage[]),
          })
        : (this.confirmationAdapter ? (req) => this.confirmationAdapter!.request(req) : undefined),
      now: options.now,
    });
  }

  get confirmation(): SceneMigrationConfirmationAdapter | undefined {
    return this.confirmationAdapter;
  }

  async openScene(scenePath: string): Promise<SceneMigrationOutcome> {
    const outcome = await this.coordinator.admit(scenePath, this.adapter);
    return outcome as SceneMigrationOutcome;
  }
}
