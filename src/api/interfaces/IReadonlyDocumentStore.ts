import type {
  CompiledScene,
  CurrentSceneDocument,
  HistoricalSceneDocumentV4,
  PreparedCompiledScene,
} from '../types/semantic-scene';

export interface IReadonlyDocumentStore {
  readonly filePath: string | null;
  readonly version: number;
  subscribe(listener: () => void): () => void;
  getCurrentSceneDocumentSnapshot(): CurrentSceneDocument | null;
  /** Historical collaboration-v2 seam. Returns null for a non-v4 current document. */
  getHistoricalSceneDocumentV4Snapshot(): HistoricalSceneDocumentV4 | null;
  getCompiledSceneSnapshot(): CompiledScene | null;
  getPreparedSceneSnapshot(): PreparedCompiledScene | null;
}
