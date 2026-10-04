import type { TimelineAction } from './semanticTimelineTypes';

export interface TrackBlockProps {
  action: TimelineAction;
  id: string;
  pixelsPerSecond: number;
  isSelected: boolean;
  onSelect: (id: string, isMulti?: boolean) => void;
  onDrag: (id: string, newTime: number) => void;
  onResize?: (id: string, newDuration: number) => void;
  repeatWarning?: string; // motionKey that this block repeats, or undefined
}

export interface TrackRowProps {
  label: string;
  trackId?: string;
  actions: { action: TimelineAction; id: string }[];
  pixelsPerSecond: number;
  selectedIds: Record<string, boolean>;
  onSelect: (id: string, isMulti?: boolean) => void;
  onDrag: (id: string, newTime: number) => void;
  onResize: (id: string, newDur: number) => void;
  viewWindow?: { start: number; end: number };
  repeatIndexMap?: Map<string, string>;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}
