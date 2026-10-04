export type ShortcutCommandId =
  | 'app.playPause'
  | 'app.frameBackward'
  | 'app.frameForward'
  | 'app.save'
  | 'app.openProject'
  | 'app.export'
  | 'app.undo'
  | 'app.redo'
  | 'app.openShortcutSettings'
  | 'stage.resetView'
  | 'timeline.copySelection'
  | 'timeline.pasteAtPlayhead'
  | 'timeline.duplicateSelection'
  | 'timeline.deleteSelection'
  | 'timeline.splitSelection'
  | 'timeline.alignSelectionToPlayhead'
  | 'timeline.nudgeSelectionLeft'
  | 'timeline.nudgeSelectionRight'
  | 'timeline.selectPrevious'
  | 'timeline.selectNext'
  | 'timeline.zoomIn'
  | 'timeline.zoomOut'
  | 'timeline.addMarker';

export type ShortcutSurface = 'app' | 'stage' | 'timeline' | 'selection';
export type ShortcutCommandScope = 'global' | 'editing' | 'stage' | 'timeline';

export interface ShortcutBinding {
  code: string;
  key?: string;
  primary?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface ShortcutCommand {
  id: ShortcutCommandId;
  label: string;
  group: string;
  description: string;
  scope: ShortcutCommandScope;
}

export interface KeyboardShortcutsSettings {
  activeProfileId: 'premiere';
  overrides: Partial<Record<ShortcutCommandId, ShortcutBinding[]>>;
}

export interface ShortcutConflict {
  commandId: ShortcutCommandId;
  commandLabel: string;
  binding: ShortcutBinding;
}
