import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { getResourceDirectoryLocations, type ResourceDirectoryLocation } from './ResourceLibrary';
import { openFolderInManager } from './fileReveal';
import { IconFolder } from './icons';
import { showToast } from './Toast';
import './ResourceFolderButton.css';

/** One folder action for the current logical directory, independent of resource selection. */
export function ResourceFolderButton({ directory, disabled = false, onError }: {
  directory: string;
  disabled?: boolean;
  onError?: (message: string | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const [locations, setLocations] = useState<ResourceDirectoryLocation[] | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const menuId = useId();

  useEffect(() => () => { requestRef.current += 1; }, []);

  const dismiss = (restoreFocus = false) => {
    setLocations(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!locations || !menuRef.current || !triggerRef.current) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.right - menu.width, window.innerWidth - menu.width - 8)),
      top: Math.max(8, anchor.bottom + menu.height + 4 <= window.innerHeight - 8
        ? anchor.bottom + 4 : anchor.top - menu.height - 4),
    });
    menuRef.current.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [locations]);

  useEffect(() => {
    if (!locations) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)
        && !triggerRef.current?.contains(event.target)) dismiss();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss(true);
      } else if (event.key === 'Tab') {
        // Return to the toolbar before the containing dialog advances focus.
        dismiss(true);
      }
    };
    const onResize = () => dismiss(true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [locations]);

  const run = async (action: (request: number) => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(true);
    onError?.(null);
    const request = ++requestRef.current;
    try { await action(request); }
    catch (error: unknown) {
      if (request !== requestRef.current) return;
      const message = error instanceof Error ? error.message : '文件夹打开失败，请重试。';
      if (onError) onError(message);
      else showToast(message, 'error');
    } finally {
      if (request === requestRef.current) {
        busyRef.current = false;
        setPending(false);
      }
    }
  };

  const handleOpen = () => {
    if (locations) { dismiss(true); return; }
    void run(async (request) => {
      const available = await getResourceDirectoryLocations(directory);
      if (request !== requestRef.current) return;
      if (!available.length) throw new Error('当前目录没有可打开的本地文件夹，请检查项目或外部资源库路径。');
      if (available.length === 1) await openFolderInManager(available[0]);
      else setLocations(available);
    });
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const current = items.findIndex((item) => item === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };

  return <>
    <button ref={triggerRef} type="button" className="btn btn--icon" disabled={disabled || pending || !directory}
      aria-label="打开当前资源文件夹" title={pending ? '正在打开…' : `打开当前资源文件夹：${directory}`}
      aria-busy={pending} aria-haspopup="menu" aria-expanded={!!locations} aria-controls={locations ? menuId : undefined}
      onClick={handleOpen}>
      <IconFolder width={14} height={14} />
    </button>
    {locations && createPortal(<div ref={menuRef} id={menuId} role="menu" aria-label="选择资源文件夹来源"
      className="resource-folder-menu" style={position} onKeyDown={handleMenuKeyDown}
      onPointerDown={(event) => event.stopPropagation()}>
      <div className="resource-folder-menu__heading">打开文件夹 · {directory}</div>
      {locations.map((location) => <button key={location.path} type="button" role="menuitem"
        className="resource-folder-menu__item" title={location.path} onClick={() => {
          dismiss(true);
          void run(async () => { await openFolderInManager(location); });
        }}>
        <IconFolder width={16} height={16} />
        <span className="resource-folder-menu__text">
          <span className="resource-folder-menu__source">{location.source}</span>
          <span className="resource-folder-menu__path">{location.path}</span>
        </span>
      </button>)}
    </div>, document.body)}
  </>;
}
