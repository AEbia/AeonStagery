import type {
  CompiledScene,
  CurrentSceneDocument,
  HistoricalSceneDocumentV4,
  PreparedCompiledScene,
  SemanticSceneBundle,
} from '../../api/types/semantic-scene';
import { isHistoricalSceneDocumentV4 } from '../../api/types/semantic-scene';
import {
  deriveSceneDocumentCanonicalOrder,
  getSceneDocumentCanonicalOrder,
  sceneDocumentCodec,
  withSceneDocumentCanonicalOrder,
} from '../../services/semantic-scene';

export interface ReadonlyDocumentStore {
  readonly filePath: string | null;
  readonly version: number;
  getCurrentSceneDocumentSnapshot(): CurrentSceneDocument | null;
  getHistoricalSceneDocumentV4Snapshot(): HistoricalSceneDocumentV4 | null;
  getCompiledSceneSnapshot(): CompiledScene | null;
  getPreparedSceneSnapshot(): PreparedCompiledScene | null;
}

export class DocumentStore implements ReadonlyDocumentStore {
  // Scene-level data
  private _currentSceneDocumentSnapshot: CurrentSceneDocument | null = null;
  private _compiledSceneSnapshot: CompiledScene | null = null;
  private _preparedSceneSnapshot: PreparedCompiledScene | null = null;
  private _sceneDocumentCanonicalOrder: readonly string[] | null = null;
  private _filePath: string | null = null;
  private _version: number = 0;
  readonly _listeners: Set<() => void> = new Set();

  get filePath(): string | null { return this._filePath; }
  get version(): number { return this._version; }

  _setFilePath(path: string | null): void {
    if (this._filePath === path) return;
    this._filePath = path;
    this._notify();
  }

  private _notify(): void {
    this._listeners.forEach(fn => fn());
  }

  // ─── Public Read ─────────────────────────────────────────────────

  getCurrentSceneDocumentSnapshot(): CurrentSceneDocument | null {
    if (!this._currentSceneDocumentSnapshot) return null;
    const snapshot = sceneDocumentCodec.prepareForSave(this._currentSceneDocumentSnapshot);
    return this._sceneDocumentCanonicalOrder
      ? withSceneDocumentCanonicalOrder(snapshot, this._sceneDocumentCanonicalOrder)
      : snapshot;
  }

  getHistoricalSceneDocumentV4Snapshot(): HistoricalSceneDocumentV4 | null {
    const document = this.getCurrentSceneDocumentSnapshot();
    return isHistoricalSceneDocumentV4(document) ? document : null;
  }

  getCompiledSceneSnapshot(): CompiledScene | null {
    return this._compiledSceneSnapshot;
  }

  getPreparedSceneSnapshot(): PreparedCompiledScene | null {
    return this._preparedSceneSnapshot;
  }

  // ─── Detached Current Scene Document Source Snapshot ────────────

  _replaceCurrentSceneDocumentSnapshot(document: CurrentSceneDocument): void {
    const canonicalOrder = getSceneDocumentCanonicalOrder(document);
    this._currentSceneDocumentSnapshot = sceneDocumentCodec.parseAndValidate(document);
    this._sceneDocumentCanonicalOrder = deriveSceneDocumentCanonicalOrder(
      this._currentSceneDocumentSnapshot,
      canonicalOrder,
    );
    this._compiledSceneSnapshot = null;
    this._preparedSceneSnapshot = null;
    this._version++;
    this._notify();
  }

  _replaceSemanticScene(bundle: SemanticSceneBundle, path?: string): void {
    // The bundle source arrives already parsed, validated and deep-frozen by
    // SemanticScenePipeline; re-validating it here would be a third full
    // document pass per commit. Only the cross-artifact consistency checks
    // that the store alone can enforce remain.
    const source = bundle.source;
    if (bundle.compiled.sourceSchemaVersion !== source.schemaVersion) {
      throw new Error('Semantic compiled scene schema does not match source document');
    }
    if (bundle.prepared.sourceSchemaVersion !== source.schemaVersion) {
      throw new Error('Prepared scene schema does not match source document');
    }
    if (bundle.compiled.sceneId !== source.sceneId || bundle.prepared.sceneId !== source.sceneId) {
      throw new Error('Semantic scene bundle contains mismatched scene ids');
    }

    const canonicalOrder = getSceneDocumentCanonicalOrder(source);
    this._currentSceneDocumentSnapshot = source;
    this._sceneDocumentCanonicalOrder = deriveSceneDocumentCanonicalOrder(
      source,
      canonicalOrder ?? this._sceneDocumentCanonicalOrder ?? undefined,
    );
    this._compiledSceneSnapshot = bundle.compiled;
    this._preparedSceneSnapshot = bundle.prepared;
    if (path !== undefined) this._filePath = path;
    this._version++;
    this._notify();
  }

  _clearCurrentSceneDocumentSnapshot(): void {
    if (!this._currentSceneDocumentSnapshot) return;
    this._currentSceneDocumentSnapshot = null;
    this._sceneDocumentCanonicalOrder = null;
    this._compiledSceneSnapshot = null;
    this._preparedSceneSnapshot = null;
    this._version++;
    this._notify();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

}
