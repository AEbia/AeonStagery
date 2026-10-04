import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { IconInfo } from './icons';
import './tooltip.css';

export type TooltipPlacement =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end';

export interface TooltipProps {
  content?: React.ReactNode;
  title?: React.ReactNode;
  shortcut?: string | string[];
  placement?: TooltipPlacement;
  delay?: number;
  disabled?: boolean;
  maxWidth?: number | string;
  className?: string;
  portal?: boolean;
  children: React.ReactElement;
}

export interface InfoTipProps {
  content: React.ReactNode;
  title?: React.ReactNode;
  shortcut?: string | string[];
  placement?: TooltipPlacement;
  size?: 'sm' | 'md';
  ariaLabel?: string;
  className?: string;
}

export function parseShortcutKeys(shortcut?: string | string[]): string[] {
  if (!shortcut) return [];
  if (Array.isArray(shortcut)) return shortcut;
  if (shortcut.includes('+')) {
    return shortcut.split('+').map((part) => part.trim());
  }
  return [shortcut];
}

export const ShortcutBadge: React.FC<{ shortcut: string | string[] }> = ({ shortcut }) => {
  const keys = parseShortcutKeys(shortcut);
  if (keys.length === 0) return null;

  return (
    <span className="app-tooltip__shortcut" aria-label={`快捷键 ${keys.join(' + ')}`}>
      {keys.map((key, index) => (
        <React.Fragment key={`${key}-${index}`}>
          {index > 0 && <span className="app-tooltip__separator">+</span>}
          <kbd className="app-tooltip__key">{key}</kbd>
        </React.Fragment>
      ))}
    </span>
  );
};

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  title,
  shortcut,
  placement = 'top',
  delay = 180,
  disabled = false,
  maxWidth = 280,
  className = '',
  portal = true,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [actualPlacement, setActualPlacement] = useState<TooltipPlacement>(placement);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const id = useId();

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const updatePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    const tooltipEl = tooltipRef.current;
    if (!triggerEl || !tooltipEl) return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const margin = 8;
    const gap = 6;

    let targetPlacement = placement;

    // Check collision & flip
    if (targetPlacement.startsWith('top') && triggerRect.top - tooltipRect.height - gap < margin) {
      targetPlacement = targetPlacement.replace('top', 'bottom') as TooltipPlacement;
    } else if (targetPlacement.startsWith('bottom') && triggerRect.bottom + tooltipRect.height + gap > viewportHeight - margin) {
      targetPlacement = targetPlacement.replace('bottom', 'top') as TooltipPlacement;
    } else if (targetPlacement.startsWith('left') && triggerRect.left - tooltipRect.width - gap < margin) {
      targetPlacement = targetPlacement.replace('left', 'right') as TooltipPlacement;
    } else if (targetPlacement.startsWith('right') && triggerRect.right + tooltipRect.width + gap > viewportWidth - margin) {
      targetPlacement = targetPlacement.replace('right', 'left') as TooltipPlacement;
    }

    setActualPlacement(targetPlacement);

    let x = 0;
    let y = 0;

    switch (targetPlacement) {
      case 'top':
        x = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
        y = triggerRect.top - tooltipRect.height - gap;
        break;
      case 'top-start':
        x = triggerRect.left;
        y = triggerRect.top - tooltipRect.height - gap;
        break;
      case 'top-end':
        x = triggerRect.right - tooltipRect.width;
        y = triggerRect.top - tooltipRect.height - gap;
        break;
      case 'bottom':
        x = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
        y = triggerRect.bottom + gap;
        break;
      case 'bottom-start':
        x = triggerRect.left;
        y = triggerRect.bottom + gap;
        break;
      case 'bottom-end':
        x = triggerRect.right - tooltipRect.width;
        y = triggerRect.bottom + gap;
        break;
      case 'left':
        x = triggerRect.left - tooltipRect.width - gap;
        y = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
        break;
      case 'right':
        x = triggerRect.right + gap;
        y = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
        break;
    }

    // Clamp inside viewport
    x = Math.max(margin, Math.min(x, viewportWidth - tooltipRect.width - margin));
    y = Math.max(margin, Math.min(y, viewportHeight - tooltipRect.height - margin));

    setCoords({ x, y });
  }, [placement]);

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition, content, title, shortcut]);

  const showTooltip = useCallback(() => {
    if (disabled || (!content && !title)) return;
    clearTimer();
    if (delay > 0) {
      timerRef.current = window.setTimeout(() => {
        setIsOpen(true);
      }, delay);
    } else {
      setIsOpen(true);
    }
  }, [clearTimer, content, delay, disabled, title]);

  const hideTooltip = useCallback(() => {
    clearTimer();
    setIsOpen(false);
  }, [clearTimer]);

  useEffect(() => {
    if (!isOpen) return;
    const handleScrollOrResize = () => updatePosition();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hideTooltip();
      }
    };

    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('scroll', handleScrollOrResize, true);
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [hideTooltip, isOpen, updatePosition]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  if (!React.isValidElement(children)) {
    return children;
  }

  const childProps = children.props as Record<string, any>;

  const triggerElement = React.cloneElement(children as React.ReactElement<any>, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const originalRef = (children as any).ref;
      if (typeof originalRef === 'function') {
        originalRef(node);
      } else if (originalRef && typeof originalRef === 'object') {
        originalRef.current = node;
      }
    },
    onMouseEnter: (e: React.MouseEvent) => {
      childProps.onMouseEnter?.(e);
      showTooltip();
    },
    onMouseLeave: (e: React.MouseEvent) => {
      childProps.onMouseLeave?.(e);
      hideTooltip();
    },
    onFocus: (e: React.FocusEvent) => {
      childProps.onFocus?.(e);
      showTooltip();
    },
    onBlur: (e: React.FocusEvent) => {
      childProps.onBlur?.(e);
      hideTooltip();
    },
    'aria-describedby': isOpen ? id : childProps['aria-describedby'],
  });

  const tooltipElement = isOpen && !disabled && (content || title) ? (
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      data-testid="app-tooltip"
      data-placement={actualPlacement}
      className={`app-tooltip-portal ${className}`}
      style={{
        left: `${coords.x}px`,
        top: `${coords.y}px`,
        maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth,
      }}
    >
      <div className="app-tooltip">
        {(title || shortcut) && (
          <div className="app-tooltip__header">
            {title && <span className="app-tooltip__title">{title}</span>}
            {shortcut && <ShortcutBadge shortcut={shortcut} />}
          </div>
        )}
        {content && <div className="app-tooltip__body">{content}</div>}
      </div>
    </div>
  ) : null;

  return (
    <>
      {triggerElement}
      {tooltipElement && (portal && typeof document !== 'undefined'
        ? createPortal(tooltipElement, document.body)
        : tooltipElement)}
    </>
  );
};

export const InfoTip: React.FC<InfoTipProps> = ({
  content,
  title,
  shortcut,
  placement = 'top',
  size = 'sm',
  ariaLabel = '更多提示',
  className = '',
}) => {
  const iconSize = size === 'sm' ? 13 : 16;

  return (
    <Tooltip
      content={content}
      title={title}
      shortcut={shortcut}
      placement={placement}
    >
      <button
        type="button"
        className={`app-infotip-trigger app-infotip-trigger--${size} ${className}`}
        aria-label={ariaLabel}
        tabIndex={0}
      >
        <IconInfo width={iconSize} height={iconSize} />
      </button>
    </Tooltip>
  );
};
