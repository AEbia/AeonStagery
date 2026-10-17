import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconFolder } from './icons';
import { showToast } from './Toast';
import { revealFileInManager, type FileRevealTarget } from './fileReveal';

type RevealErrorHandler = (message: string | null) => void;

async function reveal(target: FileRevealTarget, onRevealError?: RevealErrorHandler): Promise<void> {
  onRevealError?.(null);
  try { await revealFileInManager(target); }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : '文件定位失败，请重试。';
    if (onRevealError) onRevealError(message);
    else showToast(message, 'error');
  }
}

export function FileRevealButton({ path, templateResource, name, compact = false, className, onRevealError }: FileRevealTarget & {
  name: string;
  compact?: boolean;
  className?: string;
  onRevealError?: RevealErrorHandler;
}) {
  const [pending, setPending] = useState(false);
  return <button type="button" className={className ?? (compact ? 'btn btn--icon' : 'btn btn--sm')}
    aria-label={`在文件管理器中显示：${name}`} title={`在文件管理器中显示：${name}`}
    disabled={pending} onClick={(event) => {
      event.stopPropagation();
      setPending(true);
      void reveal({ path, templateResource }, onRevealError).finally(() => setPending(false));
    }}>
    <IconFolder width={14} height={14} />
    {!compact && <span>在文件管理器中显示</span>}
  </button>;
}

/** Shared contextual action for project and resource rows; visible buttons remain keyboard discoverable. */
export function FileRevealContext({ path, templateResource, name, children, enabled = true, onRevealError }: FileRevealTarget & {
  name: string;
  children: ReactNode;
  enabled?: boolean;
  onRevealError?: RevealErrorHandler;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!position) return;
    buttonRef.current?.focus();
    const dismiss = () => setPosition(null);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        previousFocus.current?.focus();
      } else if (event.key === 'Tab') dismiss();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [position]);
  const open = (x: number, y: number) => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - 240)), y: Math.max(8, Math.min(y, window.innerHeight - 60)) });
  };
  return <div style={{ display: 'contents' }} onContextMenu={(event) => {
    if (!enabled) return;
    event.preventDefault();
    event.stopPropagation();
    open(event.clientX, event.clientY);
  }} onKeyDown={(event) => {
    if (!enabled) return;
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = (event.target as HTMLElement).getBoundingClientRect();
    open(bounds.left, bounds.bottom);
  }}>
    {children}
    {position && createPortal(<div role="menu" aria-label={`${name}的文件操作`}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={(event) => event.stopPropagation()}
      style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 11000, width: 'min(224px, calc(100vw - 16px))', padding: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
      <button ref={buttonRef} type="button" role="menuitem" className="btn" style={{ width: '100%' }}
        onClick={() => {
          setPosition(null);
          previousFocus.current?.focus();
          void reveal({ path, templateResource }, onRevealError);
        }}>在文件管理器中显示</button>
    </div>, document.body)}
  </div>;
}
