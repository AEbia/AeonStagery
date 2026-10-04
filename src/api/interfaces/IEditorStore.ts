import type { SceneStatementDraft } from '../types/semantic-scene';
import type { SaveStatus } from '../../ui/store/EditorStore';
import type { IReadonlyEditorStore } from './IReadonlyEditorStore';

export interface IEditorStore extends IReadonlyEditorStore {
  setSelectedIds(ids: Record<string, boolean>): void;
  setCopyBuffer(statements: SceneStatementDraft[]): void;
  setUndoState(canUndo: boolean, canRedo: boolean): void;
  setPixelsPerSecond(pps: number): void;
  setGizmosVisible(visible: boolean): void;
  setSaveStatus(status: SaveStatus): void;
  setCustomMotionEditorActionId(id: string | null): void;
}
