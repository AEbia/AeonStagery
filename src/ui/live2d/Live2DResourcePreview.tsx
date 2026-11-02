import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Live2DPerformanceKind } from '../../engine/runtime/Live2DRuntimeContracts';
import { useOptionalApp } from '../context/AppContext';
import { IconRefresh, IconX } from '../icons';
import { isPreviewResponse, type PreviewRequest } from './previewProtocol';
import { constrainPreviewBounds, placeResourcePreview, type PreviewLayout } from './resourcePreviewLayout';
import { useResourcePreviewMotion } from './useResourcePreviewMotion';
import './resourcePreview.css';

// Browsing another picker replaces the open window and releases its frame.
let dismissActivePreview: (() => void) | null = null;

interface Live2DResourcePreviewProps {
  modelPath: string;
  kind: Live2DPerformanceKind;
  resourceKey: string;
  playbackId: number;
  characterName?: string;
  anchorRef: RefObject<HTMLElement>;
  overlayRef: RefObject<HTMLElement>;
  panelRef: RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  onExited: () => void;
}

/** The picker knows only the model and resource; no stage character is borrowed. */
export function Live2DResourcePreview({ modelPath, kind, resourceKey, playbackId, characterName,
  anchorRef, overlayRef, panelRef, open, onClose, onExited }: Live2DResourcePreviewProps) {
  const app = useOptionalApp();
  const projectResources = app?.services?.projectResources;
  const fileAccess = app?.services?.fileAccess;
  const titleId = useId();
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const manuallyPlaced = useRef(false);
  const [layout, setLayout] = useState<PreviewLayout | null>(null);
  const layoutRef = useRef(layout);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const requestId = useRef(0);
  const [modelUrl, setModelUrl] = useState('');
  const [ready, setReady] = useState(false);
  const [replay, setReplay] = useState(0);
  const [frameVersion, setFrameVersion] = useState(0);
  const [status, setStatus] = useState<'loading' | 'playing' | 'error'>('loading');
  const [error, setError] = useState('');
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => { layoutRef.current = layout; }, [layout]);

  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.inert = !open;
    if (!open) { dragRef.current = null; return; }
    const anchor = anchorRef.current;
    const overlay = overlayRef.current;
    if (!anchor || !overlay) return;
    let tracking = true;
    const update = () => {
      // A removed list reports a zero rect; keep the last placement for its preview's exit.
      if (!tracking || !anchor.isConnected || !overlay?.isConnected) return;
      const rect = anchor.getBoundingClientRect();
      const list = overlay?.getBoundingClientRect() ?? rect;
      const left = Math.min(rect.left, list.left);
      const top = Math.min(rect.top, list.top);
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const current = layoutRef.current;
      const next = manuallyPlaced.current && current
        ? { ...current, ...constrainPreviewBounds(current, viewport) }
        : placeResourcePreview({ left, top,
          width: Math.max(rect.right, list.right) - left, height: Math.max(rect.bottom, list.bottom) - top,
        }, viewport);
      if (current && current.left === next.left && current.top === next.top
        && current.width === next.width && current.height === next.height && current.side === next.side) return;
      layoutRef.current = next;
      setLayout(next);
    };
    let frame = 0;
    const schedule = () => {
      if (!tracking || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    };
    const onScroll = (event: Event) => {
      // Only the picker and its scroll ancestors can move its preview anchor.
      if (event.target instanceof Node && !event.target.contains(anchor)) return;
      schedule();
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(anchor);
    if (overlay) observer?.observe(overlay);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      tracking = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchorRef, overlayRef, panelRef, open]);

  useResourcePreviewMotion(panelRef, open, layout !== null, onExited);

  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const path = projectResources?.getCurrentProject()
        ? await projectResources.resolveForRead(modelPath)
        : fileAccess ? (await fileAccess.readAsset(modelPath)).path : modelPath;
      return path.startsWith('asset://') ? path : encodeURI(`asset://localhost/${path.replace(/\\/g, '/')}`);
    };
    void resolve().then((url) => { if (!cancelled) setModelUrl(url); }, (cause: unknown) => {
      if (cancelled) return;
      setError(cause instanceof Error ? cause.message : '模型文件无法读取，请检查模型路径。');
      setStatus('error');
    });
    return () => { cancelled = true; };
  }, [modelPath, projectResources, fileAccess, frameVersion]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => onCloseRef.current();
    dismissActivePreview?.();
    dismissActivePreview = dismiss;
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow || !isPreviewResponse(event.data)) return;
      const message = event.data;
      if (message.type === 'live2d-preview:ready') { setReady(true); return; }
      if (message.type === 'live2d-preview:close') { onCloseRef.current(); return; }
      if (message.requestId !== requestId.current) return;
      if (message.type === 'live2d-preview:error') { setError(message.message); setStatus('error'); }
      else setStatus('playing');
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('message', receive);
    document.addEventListener('keydown', escape);
    return () => {
      if (dismissActivePreview === dismiss) dismissActivePreview = null;
      window.removeEventListener('message', receive);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !ready || !modelUrl) return;
    const request: PreviewRequest = {
      type: 'live2d-preview:play', requestId: ++requestId.current, modelUrl, kind, key: resourceKey,
    };
    setStatus('loading');
    frameRef.current?.contentWindow?.postMessage(request, '*');
  }, [open, ready, modelUrl, kind, resourceKey, playbackId, replay]);

  const title = kind === 'motion' ? '动作预览' : '表情预览';
  const frameUrl = new URL('live2d-preview.html', window.location.href);
  if (window.aeonStageryAPI) frameUrl.searchParams.set('runtimeHost', 'desktop');
  const style: CSSProperties & Record<`--preview-${string}`, string> = {
    left: layout?.left, top: layout?.top, width: layout?.width, height: layout?.height,
    visibility: layout ? undefined : 'hidden',
    '--preview-offset-x': layout?.side === 'left' ? '12px' : layout?.side === 'right' ? '-12px' : '0px',
    '--preview-offset-y': layout?.side === 'top' ? '12px' : layout?.side === 'bottom' ? '-12px' : '0px',
    '--preview-origin': layout?.side === 'left' ? 'right center' : layout?.side === 'right' ? 'left center'
      : layout?.side === 'top' ? 'center bottom' : 'center top',
  };
  return createPortal(
    <section ref={panelRef} className="live2d-resource-preview" role="dialog" aria-labelledby={titleId} aria-modal="false"
      aria-hidden={!open || undefined} data-state={open ? 'open' : 'closing'} style={style}>
      <header className="live2d-resource-preview__header"
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
          if (!open || !layout) return;
          dragRef.current = { x: event.clientX - layout.left, y: event.clientY - layout.top };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!open || !drag) return;
          manuallyPlaced.current = true;
          setLayout((current) => current ? { ...current, ...constrainPreviewBounds({ ...current,
            left: event.clientX - drag.x, top: event.clientY - drag.y,
          }, { width: window.innerWidth, height: window.innerHeight }) } : current);
        }}
        onPointerUp={() => { dragRef.current = null; }}
        onLostPointerCapture={() => { dragRef.current = null; }}>
        <div>
          <strong id={titleId}>{title}</strong>
          {characterName && <span className="live2d-resource-preview__character">{characterName}</span>}
        </div>
        <button type="button" className="btn btn--icon" onClick={onClose} disabled={!open} aria-label="关闭角色预览" title="关闭预览">
          <IconX width={14} height={14} />
        </button>
      </header>
      <div className="live2d-resource-preview__viewport" aria-busy={status === 'loading'}>
        {modelUrl && <iframe key={frameVersion} ref={frameRef} src={frameUrl.href}
          title={`${title}模型`} onLoad={() => setReady(true)} />}
        {status === 'loading' && <div className="live2d-resource-preview__status" role="status">正在加载预览…</div>}
        {status === 'error' && <div className="live2d-resource-preview__status" role="alert">{error}</div>}
      </div>
      <footer className="live2d-resource-preview__footer">
        <span title={resourceKey}>{resourceKey}</span>
        <button type="button" className="btn" onClick={() => {
          if (status === 'error') {
            setReady(false);
            setModelUrl('');
            setStatus('loading');
            setFrameVersion((value) => value + 1);
          } else setReplay((value) => value + 1);
        }} disabled={!open || status === 'loading'}>
          <IconRefresh width={12} height={12} />{status === 'error' ? '重试' : '重播'}
        </button>
      </footer>
    </section>, document.body,
  );
}
