import type { SceneStatementDraft } from '../../api/types/semantic-scene';
import type { IEditorStore } from '../../api/interfaces';

type EditorListener = () => void;

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'error';

export class EditorStore implements IEditorStore {
  private _selectedActionIds: Record<string, boolean> = {};
  private _copyBuffer: SceneStatementDraft[] = [];
  private _canUndo: boolean = false;
  private _canRedo: boolean = false;
  private _pixelsPerSecond: number = 50;
  private _gizmosVisible: boolean = false;
  private _collapsedTracks: Set<string> = new Set();
  private _saveStatus: SaveStatus = 'idle';
  private _customMotionEditorActionId: string | null = null;
  readonly _listeners: Set<EditorListener> = new Set();

  get selectedActionIds(): Record<string, boolean> {
    return { ...this._selectedActionIds };
  }
  get selectedActionIdsSnapshot(): Readonly<Record<string, boolean>> {
    return this._selectedActionIds;
  }
  get copyBuffer(): SceneStatementDraft[] { return this._copyBuffer; }
  get canUndo(): boolean { return this._canUndo; }
  get canRedo(): boolean { return this._canRedo; }
  get pixelsPerSecond(): number { return this._pixelsPerSecond; }
  get gizmosVisible(): boolean { return this._gizmosVisible; }
  get collapsedTracks(): Set<string> { return this._collapsedTracks; }
  get saveStatus(): SaveStatus { return this._saveStatus; }
  get customMotionEditorActionId(): string | null { return this._customMotionEditorActionId; }

  /** Check if an action is selected. O(1). */
  isSelected(id: string): boolean {
    return !!this._selectedActionIds[id];
  }

  /** Get count of selected actions. */
  get selectedCount(): number {
    return Object.keys(this._selectedActionIds).length;
  }

  /** Get the first selected id (for single-selection inspector). */
  get firstSelectedId(): string | null {
    for (const id of Object.keys(this._selectedActionIds)) {
      if (this._selectedActionIds[id]) return id;
    }
    return null;
  }

  _setSelectedIds(ids: Record<string, boolean>): void {
    this._selectedActionIds = ids;
    this._notify();
  }

  _setCopyBuffer(statements: SceneStatementDraft[]): void {
    this._copyBuffer = statements;
    this._notify();
  }

  _setUndoState(canUndo: boolean, canRedo: boolean): void {
    this._canUndo = canUndo;
    this._canRedo = canRedo;
    this._notify();
  }

  _setPixelsPerSecond(pps: number): void {
    if (this._pixelsPerSecond === pps) return;
    this._pixelsPerSecond = pps;
    this._notify();
  }

  _setGizmosVisible(visible: boolean): void {
    if (this._gizmosVisible === visible) return;
    this._gizmosVisible = visible;
    this._notify();
  }

  _setCollapsedTracks(tracks: Set<string>): void {
    this._collapsedTracks = tracks;
    this._notify();
  }

  _setSaveStatus(status: SaveStatus): void {
    if (this._saveStatus === status) return;
    this._saveStatus = status;
    this._notify();
  }

  _setCustomMotionEditorActionId(id: string | null): void {
    if (this._customMotionEditorActionId === id) return;
    this._customMotionEditorActionId = id;
    this._notify();
  }

  private _notify(): void {
    for (const fn of this._listeners) fn();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  setSelectedIds(ids: Record<string, boolean>): void {
    this._setSelectedIds(ids);
  }

  setCopyBuffer(statements: SceneStatementDraft[]): void {
    this._setCopyBuffer(statements);
  }

  setUndoState(canUndo: boolean, canRedo: boolean): void {
    this._setUndoState(canUndo, canRedo);
  }

  setPixelsPerSecond(pps: number): void {
    this._setPixelsPerSecond(pps);
  }

  setGizmosVisible(visible: boolean): void {
    this._setGizmosVisible(visible);
  }

  setSaveStatus(status: SaveStatus): void {
    this._setSaveStatus(status);
  }

  setCustomMotionEditorActionId(id: string | null): void {
    this._setCustomMotionEditorActionId(id);
  }
}
