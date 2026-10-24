import { memo } from 'react';
import type { SourcedSemanticAuthoringCombo } from '../../services/template-package';
import { StatementLibraryMenu } from './StatementLibraryMenu';

interface BlankMenuState {
  x: number;
  y: number;
  time: number;
  charId: string | null;
  charLabel: string | null;
}

interface BlankContextMenuProps {
  menu: BlankMenuState | null;
  hasCopyBuffer: boolean;
  templates?: SourcedSemanticAuthoringCombo[];
  onPaste: (time: number) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The shared selection callback carries either a statement block or a template payload chosen at runtime; preserve the existing menu callback boundary.
  onSelectAction: (type: 'statement' | 'template', data: any) => void;
  availableLifecycleEndCommandIds?: ReadonlySet<string>;
  availableStateSpanDependencyCommandIds?: ReadonlySet<string>;
}

export const BlankContextMenu = memo(({
  menu,
  hasCopyBuffer,
  templates,
  onPaste,
  onSelectAction,
  availableLifecycleEndCommandIds,
  availableStateSpanDependencyCommandIds,
}: BlankContextMenuProps) => {
  return (
    <StatementLibraryMenu
      menu={menu ? {
        x: menu.x,
        y: menu.y,
        time: menu.time,
        ...(menu.charLabel || menu.charId
          ? { contextMeta: menu.charLabel || menu.charId || undefined }
          : {}),
      } : null}
      hasCopyBuffer={hasCopyBuffer}
      templates={templates}
      onPaste={onPaste}
      onSelectAction={onSelectAction}
      dataTestId="timeline-blank-insert-menu"
      ariaLabel="空白轨道插入菜单"
      availableLifecycleEndCommandIds={availableLifecycleEndCommandIds}
      availableStateSpanDependencyCommandIds={availableStateSpanDependencyCommandIds}
    />
  );
});

BlankContextMenu.displayName = 'BlankContextMenu';
