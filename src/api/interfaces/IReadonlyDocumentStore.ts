import type {
  CompiledScene,
  CurrentSceneDocument,
  PreparedCompiledScene,
} from '../types/semantic-scene';

export interface IReadonlyDocumentStore {
  readonly filePath: string | null;
  readonly version: number;
  subscribe(listener: () => void): () => void;
  getCurrentSceneDocumentSnapshot(): CurrentSceneDocument | null;
  /** Stable deeply frozen source; read-only callers avoid full document copies. */
  getCurrentSceneDocumentView(): CurrentSceneDocument | null;
  getCompiledSceneSnapshot(): CompiledScene | null;
  getPreparedSceneSnapshot(): PreparedCompiledScene | null;
}
