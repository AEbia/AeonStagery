import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { StatementBlockLibrary } from '../StatementBlockLibrary';
import { IconChevronLeft, IconChevronRight, IconClock, IconCopy, IconUser } from '../icons';
import type { SourcedSemanticAuthoringCombo } from '../../services/template-package';

export interface StatementLibraryMenuState {
  readonly x: number;
  readonly y: number;
  readonly time: number;
  readonly contextMeta?: string;
}

interface StatementLibraryMenuProps {
  readonly menu: StatementLibraryMenuState | null;
  readonly templates?: SourcedSemanticAuthoringCombo[];
  readonly onPaste?: (time: number) => void;
  readonly hasCopyBuffer?: boolean;
  readonly onSelectAction: (type: 'statement' | 'template', data: any) => void;
  readonly onDismiss?: () => void;
  readonly availableLifecycleEndCommandIds?: ReadonlySet<string>;
  readonly availableStateSpanDependencyCommandIds?: ReadonlySet<string>;
  readonly dataTestId: string;
  readonly ariaLabel: string;
  readonly className?: string;
  readonly autoFocusSearch?: boolean;
}

const CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'history', label: '历史' },
  { id: 'dialogue', label: '对话' },
  { id: 'character', label: '角色' },
  { id: 'template', label: '组合母版' },
  { id: 'camera', label: '镜头' },
  { id: 'scene', label: '场景' },
  { id: 'visual', label: '画面效果' },
  { id: 'audio', label: '音频' },
  { id: 'layer', label: '图层' },
] as const;

const HIDDEN_MENU_STATEMENT_BLOCK_IDS: ReadonlySet<string> = new Set([
  'visual.modulate-character-integration',
  // Color overlays are now authored as part of lighting.post. Keep the
  // standalone statements in the registry for legacy scenes and lifecycle
  // editing, but do not offer them as new insertion entry points.
  'lighting.overlay',
  'lighting.modulate-overlay',
  'lighting.remove-overlay',
  'lighting.clear-overlay',
]);

export const StatementLibraryMenu = memo(({
  menu,
  templates,
  onPaste,
  hasCopyBuffer = false,
  onSelectAction,
  onDismiss,
  availableLifecycleEndCommandIds,
  availableStateSpanDependencyCommandIds,
  dataTestId,
  ariaLabel,
  className,
  autoFocusSearch = false,
}: StatementLibraryMenuProps) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const categoriesRef = useRef<HTMLDivElement | null>(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [categoryScrollState, setCategoryScrollState] = useState({
    canScrollLeft: false,
    canScrollRight: false,
  });
  const menuKey = menu ? `${menu.x}:${menu.y}:${menu.time}:${menu.contextMeta ?? ''}` : '';
  const menuX = menu?.x ?? null;
  const menuY = menu?.y ?? null;
  const menuPosition = useMemo(() => {
    if (menuX === null || menuY === null) return null;
    const viewportPadding = 12;
    const width = Math.min(420, Math.max(0, window.innerWidth - viewportPadding * 2));
    const maxHeight = Math.min(520, Math.max(0, window.innerHeight - viewportPadding * 2));
    return {
      left: Math.max(viewportPadding, Math.min(menuX, window.innerWidth - width - viewportPadding)),
      top: Math.max(viewportPadding, Math.min(menuY, window.innerHeight - viewportPadding - 260)),
      width,
      maxHeight,
      minHeight: Math.min(260, maxHeight),
    };
  }, [menuX, menuY]);
  const [measuredPosition, setMeasuredPosition] = useState(menuPosition);

  const updateCategoryScrollState = useCallback(() => {
    const element = categoriesRef.current;
    if (!element) return;
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCategoryScrollState({
      canScrollLeft: element.scrollLeft > 0,
      canScrollRight: element.scrollLeft < maxScrollLeft - 1,
    });
  }, []);

  useLayoutEffect(() => {
    setActiveCategory('all');
    if (categoriesRef.current) categoriesRef.current.scrollLeft = 0;
    updateCategoryScrollState();
    if (menuKey) menuRef.current?.focus({ preventScroll: true });
  }, [menuKey, updateCategoryScrollState]);

  useLayoutEffect(() => {
    const element = categoriesRef.current;
    if (!element || !menuKey) return;
    updateCategoryScrollState();
    element.addEventListener('scroll', updateCategoryScrollState, { passive: true });
    window.addEventListener('resize', updateCategoryScrollState);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateCategoryScrollState);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', updateCategoryScrollState);
      window.removeEventListener('resize', updateCategoryScrollState);
      observer?.disconnect();
    };
  }, [menuKey, updateCategoryScrollState]);

  useLayoutEffect(() => {
    if (menuX === null || menuY === null || !menuPosition) {
      setMeasuredPosition(null);
      return;
    }
    const viewportPadding = 12;
    const element = menuRef.current;
    const actualWidth = element?.offsetWidth || menuPosition.width;
    const actualHeight = element
      ? Math.min(element.offsetHeight, menuPosition.maxHeight)
      : Math.min(260, menuPosition.maxHeight);
    setMeasuredPosition({
      ...menuPosition,
      left: Math.max(viewportPadding, Math.min(menuX, window.innerWidth - actualWidth - viewportPadding)),
      top: Math.max(viewportPadding, Math.min(menuY, window.innerHeight - actualHeight - viewportPadding)),
    });
  }, [menuKey, menuPosition, menuX, menuY]);

  useLayoutEffect(() => {
    if (!menuKey || !onDismiss) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !menuRef.current?.contains(target)) onDismiss();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuKey, onDismiss]);

  const handleCategoryWheel = (event: WheelEvent<HTMLDivElement>) => {
    const element = categoriesRef.current;
    if (!element) return;
    const maxScrollLeft = element.scrollWidth - element.clientWidth;
    if (maxScrollLeft <= 0) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    element.scrollLeft += delta;
    updateCategoryScrollState();
  };

  const scrollCategories = (direction: -1 | 1) => {
    const element = categoriesRef.current;
    if (!element) return;
    const distance = Math.max(80, Math.floor(element.clientWidth * 0.72));
    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    element.scrollLeft = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft + direction * distance));
    updateCategoryScrollState();
  };

  if (!menu) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={['track-blank-menu', className].filter(Boolean).join(' ')}
      data-testid={dataTestId}
      role="dialog"
      aria-label={ariaLabel}
      tabIndex={-1}
      style={{
        left: measuredPosition?.left,
        top: measuredPosition?.top,
        width: measuredPosition?.width,
        minHeight: measuredPosition?.minHeight,
        maxHeight: measuredPosition?.maxHeight,
      }}
    >
      <div className="track-blank-menu__topbar">
        <div className="track-blank-menu__context">
          <div className="track-blank-menu__title">
            <IconClock width={14} height={14} />
            插入 {menu.time.toFixed(1)}s
          </div>
          {menu.contextMeta && (
            <div className="track-blank-menu__meta">
              <IconUser width={12} height={12} />
              {menu.contextMeta}
            </div>
          )}
        </div>
        <div className="track-blank-menu__category-nav">
          <button
            type="button"
            className="track-blank-menu__category-nav-button"
            aria-label="向左滚动语句类型"
            title="向左滚动语句类型"
            disabled={!categoryScrollState.canScrollLeft}
            onClick={() => scrollCategories(-1)}
          >
            <IconChevronLeft width={13} height={13} aria-hidden="true" />
          </button>
          <div
            ref={categoriesRef}
            className="track-blank-menu__categories"
            role="tablist"
            aria-label="语句类型"
            onWheel={handleCategoryWheel}
          >
            {CATEGORIES.map((category) => (
              <button
                key={category.id}
                type="button"
                role="tab"
                aria-selected={activeCategory === category.id}
                className={[
                  'track-blank-menu__category',
                  activeCategory === category.id ? 'track-blank-menu__category--active' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setActiveCategory(category.id)}
              >
                {category.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="track-blank-menu__category-nav-button"
            aria-label="向右滚动语句类型"
            title="向右滚动语句类型"
            disabled={!categoryScrollState.canScrollRight}
            onClick={() => scrollCategories(1)}
          >
            <IconChevronRight width={13} height={13} aria-hidden="true" />
          </button>
        </div>
        {onPaste && (
          <button
            className="btn btn--sm track-blank-menu__paste"
            type="button"
            disabled={!hasCopyBuffer}
            onClick={() => onPaste(menu.time)}
            title={hasCopyBuffer ? '粘贴到当前插入点' : '没有可粘贴的动作'}
          >
            <IconCopy width={13} height={13} />
            {hasCopyBuffer ? '粘贴此处' : '无可粘贴'}
          </button>
        )}
      </div>

      <StatementBlockLibrary
        className="statement-block-library--menu"
        style={{ flex: 1, minHeight: 0 }}
        activeCategory={activeCategory}
        templates={templates}
        onSelectAction={onSelectAction}
        autoFocusSearch={autoFocusSearch}
        hideDescriptions
        hiddenStatementBlockIds={HIDDEN_MENU_STATEMENT_BLOCK_IDS}
        availableLifecycleEndCommandIds={availableLifecycleEndCommandIds}
        availableStateSpanDependencyCommandIds={availableStateSpanDependencyCommandIds}
      />
    </div>,
    document.body,
  );
});

StatementLibraryMenu.displayName = 'StatementLibraryMenu';
