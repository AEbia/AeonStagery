import type { SceneStatementDraft } from '../types/semantic-scene';
import type { SaveStatus } from '../../ui/store/EditorStore';

export interface IReadonlyEditorStore {
  readonly selectedActionIds: Record<string, boolean>;
  readonly copyBuffer: SceneStatementDraft[];
  readonly pixelsPerSecond: number;
  readonly gizmosVisible: boolean;
  readonly saveStatus: SaveStatus;
  /** 当前在轨道区展开关键帧编辑器的动作 id（null 表示未展开）。 */
  readonly customMotionEditorActionId: string | null;
  subscribe(listener: () => void): () => void;
}
