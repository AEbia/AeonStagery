import type { SceneStatementDraft } from '../types/semantic-scene';
import type { SaveStatus } from '../../ui/store/EditorStore';

export interface IReadonlyEditorStore {
  readonly selectedActionIds: Record<string, boolean>;
  readonly copyBuffer: SceneStatementDraft[];
  readonly pixelsPerSecond: number;
  readonly gizmosVisible: boolean;
  readonly saveStatus: SaveStatus;
  subscribe(listener: () => void): () => void;
}
