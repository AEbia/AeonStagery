export interface ITimelineAdapter {
  select(ids: Record<string, boolean>): void;
  selectSingle(id: string): void;
  toggleSelection(id: string): void;
  clearSelection(): void;
  getSelectedIds(): Record<string, boolean>;
}
