import { IFileAccess } from './IFileAccess';
import { ReadonlyDocumentStore } from '../../ui/store/DocumentStore';
import type { ValidationIssue } from '../../api/types/validation';
import type { ISceneFileService } from '../../api/interfaces';
import type { CompiledScene, CurrentSceneDocument, SceneDocumentV5 } from '../../api/types/semantic-scene';
import {
  CompatibleSceneSession,
  SceneMigrationExperience,
  sceneDocumentCodec,
  sceneStatementCompiler,
} from '../semantic-scene';
import type {
  DocumentFilePathPort,
  EditorSaveStatusPort,
} from '../document/DocumentProjectionPorts';
import type { SemanticDocumentCoordinator } from '../document/SemanticDocumentCoordinator';

export type LoadResult =
  | { success: true; path: string; issues: ValidationIssue[] }
  | { success: false; path?: string; error: string }
  | { success: false; path?: string; cancelled: true };

export type SaveResult =
  | { success: true; path: string }
  | { success: false; path?: string; error: string }
  | { success: false; path?: string; cancelled: true };

export type CurrentSceneDocumentParseResult =
  | {
      success: true;
      path: string;
      sourceKind: 'current-scene-document';
      document: CurrentSceneDocument;
      compiled: CompiledScene;
    }
  | {
      success: false;
      path?: string;
      error: string;
    };

export type SemanticSceneLoadResult =
  | { success: true; path: string; document: CurrentSceneDocument }
  | { success: false; path?: string; error: string };

type LoadMode = 'raw' | 'path';

interface LoadSessionResult {
  session: CompatibleSceneSession;
  warnings: readonly string[];
  cancelled?: false;
}

type LoadSessionOutcome = LoadSessionResult | { cancelled: true };

export class SceneFileService implements ISceneFileService {
  private compatibleSession: CompatibleSceneSession | null = null;

  constructor(
    private fileAccess: IFileAccess,
    private documentStore: ReadonlyDocumentStore,
    private documentFilePath: DocumentFilePathPort,
    private saveStatus: EditorSaveStatusPort,
    private semanticCoordinator?: SemanticDocumentCoordinator,
    private migration?: SceneMigrationExperience,
  ) {}

  /**
   * Open a document through the compatibility adapter without touching disk
   * (Raw Script replacement, examples, or tests). Migration runs in memory
   * only; the user-facing gated flow is reserved for real files.
   */
  private async openSessionFromRaw(input: unknown): Promise<LoadSessionResult> {
    const outcome = CompatibleSceneSession.open(input);
    switch (outcome.status) {
      case 'ready':
        return { session: outcome.session, warnings: [] };
      case 'migration_required': {
        const migrated = outcome.plan.migrate();
        return { session: migrated.session, warnings: migrated.warnings };
      }
      case 'incompatible':
      case 'invalid':
        throw new Error(outcome.issue.message);
    }
  }

  /**
   * Open a real scene file through the gated SceneMigrationExperience when one
   * is configured: it backs up the original, asks the user to confirm an
   * in-place upgrade, and returns a CompatibleSceneSession whose source
   * retains unknown fields. Without a configured experience it degrades to the
   * raw in-memory path.
   */
  private async openSessionFromPath(path: string): Promise<LoadSessionOutcome> {
    if (!this.migration) {
      const { data } = await this.fileAccess.readFile(path);
      return this.openSessionFromRaw(JSON.parse(data));
    }
    const outcome = await this.migration.openScene(path);
    switch (outcome.status) {
      case 'ready':
        return { session: outcome.session, warnings: [] };
      case 'migrated':
        return { session: outcome.session, warnings: outcome.warnings };
      case 'cancelled':
        return { cancelled: true };
      case 'incompatible':
      case 'invalid':
        throw new Error(outcome.issue.message);
    }
  }

  private async loadJson(rawJson: string, path: string, mode: LoadMode): Promise<LoadResult> {
    if (!this.semanticCoordinator) {
      return { success: false, path, error: 'Semantic scene pipeline is not configured' };
    }
    try {
      const raw = JSON.parse(rawJson);
      if (!isCurrentSceneDocumentInput(raw)) {
        return { success: false, path, error: 'Only current Scene Document JSON is supported' };
      }
      const outcome = mode === 'path'
        ? await this.openSessionFromPath(path)
        : await this.openSessionFromRaw(raw);
      if (outcome.cancelled) {
        return { success: false, path, cancelled: true };
      }
      this.compatibleSession = outcome.session;
      await this.semanticCoordinator.applyDocument(outcome.session.projection, path);
      return {
        success: true,
        path,
        issues: outcome.warnings.map((message): ValidationIssue => ({ severity: 'warning', message })),
      };
    } catch (err: any) {
      return { success: false, path, error: err.message || String(err) };
    }
  }

  private async loadPathContents(data: string, path: string): Promise<LoadResult> {
    // In production a SceneMigrationExperience performs the gated
    // (backup + confirm) in-place upgrade. Tests and non-UI callers that do
    // not configure one keep the old in-memory behavior.
    return this.loadJson(data, path, this.migration ? 'path' : 'raw');
  }

  async loadExample(): Promise<LoadResult> {
    try {
      const { data, path } = await this.fileAccess.readAsset('start.json');
      return await this.loadJson(data, path, 'raw');
    } catch (err: any) {
      return { success: false, path: 'start.json', error: err.message || String(err) };
    }
  }

  async loadFile(): Promise<LoadResult> {
    try {
      const result = await this.fileAccess.showOpenDialog();
      if (!result) return { success: false, cancelled: true };
      return await this.loadPathContents(result.data, result.path);
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  async loadFromPath(path: string): Promise<LoadResult> {
    try {
      const { data } = await this.fileAccess.readFile(path);
      return await this.loadPathContents(data, path);
    } catch (err: any) {
      return { success: false, path, error: err.message || String(err) };
    }
  }

  async loadFromRawJson(rawJson: string, pathHint?: string): Promise<LoadResult> {
    const path = pathHint ?? this.documentStore.filePath ?? '[raw-scene]';
    return this.loadJson(rawJson, path, 'raw');
  }

  async parseCurrentSceneDocumentFromRawJson(
    rawJson: string,
    pathHint?: string,
  ): Promise<CurrentSceneDocumentParseResult> {
    const path = pathHint ?? this.documentStore.filePath ?? '[raw-scene]';
    try {
      const raw = JSON.parse(rawJson);
      const outcome = CompatibleSceneSession.open(raw);
      const session = outcome.status === 'ready'
        ? outcome.session
        : outcome.status === 'migration_required'
          ? outcome.plan.migrate().session
          : (() => { throw new Error(outcome.issue.message); })();
      const document = session.projection;
      const compiled = sceneStatementCompiler.compile(document);
      return {
        success: true,
        path,
        sourceKind: 'current-scene-document',
        document,
        compiled,
      };
    } catch (err: any) {
      return { success: false, path, error: err.message || String(err) };
    }
  }

  async saveCurrentSceneDocument(document: CurrentSceneDocument, path: string): Promise<SaveResult> {
    try {
      this.saveStatus.setSaveStatus('saving');
      const prepared = sceneDocumentCodec.prepareForSave(document);
      sceneStatementCompiler.compile(prepared);
      const serialized = this.serializeWithUnknownPreservation(prepared as SceneDocumentV5);
      await this.fileAccess.writeFile(path, JSON.stringify(serialized, null, 2));
      this.saveStatus.setSaveStatus('idle');
      return { success: true, path };
    } catch (err: any) {
      this.saveStatus.setSaveStatus('error');
      return { success: false, path, error: err.message || String(err) };
    }
  }

  /**
   * Reconcile the typed document back into the retained Compatibility Source
   * so unknown fields authored by a newer reader survive the save. Falls back
   * to the typed document when no session exists or reconciliation fails.
   */
  private serializeWithUnknownPreservation(prepared: CurrentSceneDocument): unknown {
    if (!this.compatibleSession) return prepared;
    try {
      return this.compatibleSession.reconcileForSave(prepared as SceneDocumentV5);
    } catch {
      return prepared;
    }
  }

  async loadCurrentSceneDocumentFromRawJson(
    rawJson: string,
    pathHint?: string,
  ): Promise<SemanticSceneLoadResult> {
    const path = pathHint ?? this.documentStore.filePath ?? '[raw-scene]';
    if (!this.semanticCoordinator) {
      return { success: false, path, error: 'Semantic scene pipeline is not configured' };
    }
    try {
      const raw = JSON.parse(rawJson);
      const outcome = await this.openSessionFromRaw(raw);
      this.compatibleSession = outcome.session;
      const bundle = await this.semanticCoordinator.applyDocument(outcome.session.projection, path);
      return { success: true, path, document: bundle.source };
    } catch (err: any) {
      return { success: false, path, error: err.message || String(err) };
    }
  }

  async loadCurrentSceneDocumentFromPath(path: string): Promise<SemanticSceneLoadResult> {
    try {
      const { data } = await this.fileAccess.readFile(path);
      return this.loadCurrentSceneDocumentFromRawJson(data, path);
    } catch (err: any) {
      return { success: false, path, error: err.message || String(err) };
    }
  }

  async save(): Promise<SaveResult> {
    const semanticDocument = this.documentStore.getCurrentSceneDocumentSnapshot();
    if (!semanticDocument) return { success: false, error: 'No semantic scene document loaded' };
    const path = this.documentStore.filePath;
    if (!path) return this.saveAs();
    return this.saveCurrentSceneDocument(semanticDocument, path);
  }

  async saveAs(): Promise<SaveResult> {
    const semanticDocument = this.documentStore.getCurrentSceneDocumentSnapshot();
    if (!semanticDocument) return { success: false, error: 'No semantic scene document loaded' };

    try {
      const path = await this.fileAccess.showSaveDialog();
      if (!path) return { success: false, cancelled: true };

      const result = await this.saveCurrentSceneDocument(semanticDocument, path);
      if (result.success) this.documentFilePath.setFilePath(path);
      return result;
    } catch (err: any) {
      this.saveStatus.setSaveStatus('error');
      return { success: false, error: err.message || String(err) };
    }
  }

}

function isCurrentSceneDocumentInput(value: unknown): value is CurrentSceneDocument {
  return !!value
    && typeof value === 'object'
    && 'schemaVersion' in value
    && 'statements' in value
    && !('timeline' in value);
}
