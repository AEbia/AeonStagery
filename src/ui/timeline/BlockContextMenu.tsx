import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

interface BlockMenuState {
  x: number;
  y: number;
  targetId: string;
  disableSplit?: boolean;
  isCompanion?: boolean;
}

interface BlockContextMenuProps {
  menu: BlockMenuState | null;
  onAction: (actionIdx: number) => void | Promise<void>;
  onDismiss: () => void;
  /** Conditional motion-action entries appended after the standard items. */
  motionItems?: Array<{ label: string; danger?: boolean }>;
  showLocateParent?: boolean;
}

export const BlockContextMenu = memo(({ menu, onAction, onDismiss, motionItems, showLocateParent }: BlockContextMenuProps) => {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!menu) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const firstEnabledIndex = 0;
    setActiveIndex(firstEnabledIndex);
    itemRefs.current[firstEnabledIndex]?.focus({ preventScroll: true });

    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [menu]);

  if (!menu) return null;

  const items: Array<{ label: string; disabled?: boolean; danger?: boolean }> = [
    { label: '复制' },
    { label: '粘贴' },
    { label: '复制动作' },
    { label: '在播放头处分裂', disabled: menu.disableSplit },
    { label: '删除', danger: true },
    ...(showLocateParent ? [{ label: '定位父对白' }] : []),
    ...(motionItems ?? []),
  ];
  const enabledIndexes = items
    .map((item, index) => item.disabled ? -1 : index)
    .filter((index) => index >= 0);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const currentPosition = Math.max(0, enabledIndexes.indexOf(activeIndex));
    const nextPosition = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? enabledIndexes.length - 1
        : (currentPosition + (event.key === 'ArrowDown' ? 1 : -1) + enabledIndexes.length)
          % enabledIndexes.length;
    const nextIndex = enabledIndexes[nextPosition];
    setActiveIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      className="track-context-menu"
      style={{
        position: 'fixed',
        left: menu.x,
        top: menu.y,
        zIndex: 10000, // Top priority root-level Portal context menu
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
        padding: 6,
        minWidth: 150,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        color: 'var(--text-primary)',
        fontSize: 13,
      }}
      role="menu"
      aria-label="区块操作"
      onKeyDown={handleKeyDown}
    >
      {items.map((item, i) => (
        <button
          key={i}
          ref={(element) => { itemRefs.current[i] = element; }}
          type="button"
          role="menuitem"
          data-menu-action={i}
          disabled={item.disabled}
          tabIndex={!item.disabled && activeIndex === i ? 0 : -1}
          aria-disabled={item.disabled ? 'true' : undefined}
          onFocus={() => setActiveIndex(i)}
          onClick={() => { if (!item.disabled) void onAction(i); }}
          style={{
            padding: '6px 12px',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: 'transparent',
            width: '100%',
            textAlign: 'left',
            fontFamily: 'inherit',
            cursor: item.disabled ? 'not-allowed' : 'pointer',
            fontSize: 12,
            color: item.disabled ? 'var(--text-muted)' : item.danger ? 'var(--error)' : 'var(--text-primary)',
            opacity: item.disabled ? 0.55 : 1,
            userSelect: 'none',
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
});

BlockContextMenu.displayName = 'BlockContextMenu';
