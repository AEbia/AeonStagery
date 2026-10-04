import type { EditorStore } from '../../ui/store/EditorStore';
import type { ITimelineAdapter } from '../../api/interfaces';

export class TimelineAdapter implements ITimelineAdapter {
  private editorStore: EditorStore;

  constructor(editorStore: EditorStore) {
    if (!editorStore) throw new Error('EditorStore is required');
    this.editorStore = editorStore;
  }

  select(ids: Record<string, boolean>): void {
    this.editorStore._setSelectedIds(ids);
  }

  selectSingle(id: string): void {
    this.editorStore._setSelectedIds({ [id]: true });
  }

  toggleSelection(id: string): void {
    const current = { ...this.editorStore.selectedActionIds };
    if (current[id]) {
      delete current[id];
    } else {
      current[id] = true;
    }
    this.editorStore._setSelectedIds(current);
  }

  clearSelection(): void {
    this.editorStore._setSelectedIds({});
  }

  getSelectedIds(): Record<string, boolean> {
    return this.editorStore.selectedActionIds;
  }
}
