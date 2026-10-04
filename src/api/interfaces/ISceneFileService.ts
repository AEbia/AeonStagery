import type {
  LoadResult,
  SaveResult,
  CurrentSceneDocumentParseResult,
  SemanticSceneLoadResult,
} from '../../services/io/SceneFileService';
import type { CurrentSceneDocument } from '../types/semantic-scene';

export interface ISceneFileService {
  loadExample(): Promise<LoadResult>;
  loadFile(): Promise<LoadResult>;
  loadFromPath(path: string): Promise<LoadResult>;
  loadFromRawJson(rawJson: string, pathHint?: string): Promise<LoadResult>;
  parseCurrentSceneDocumentFromRawJson?(rawJson: string, pathHint?: string): Promise<CurrentSceneDocumentParseResult>;
  saveCurrentSceneDocument?(document: CurrentSceneDocument, path: string): Promise<SaveResult>;
  loadCurrentSceneDocumentFromRawJson?(rawJson: string, pathHint?: string): Promise<SemanticSceneLoadResult>;
  loadCurrentSceneDocumentFromPath?(path: string): Promise<SemanticSceneLoadResult>;
  save(): Promise<SaveResult>;
  saveAs(): Promise<SaveResult>;
}
