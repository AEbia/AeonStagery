import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronDown } from './icons';
import { useOutsidePointerDown } from './hooks/useOutsidePointerDown';

export interface FormSelectOption {
  value: string | number;
  label: string;
  selectedLabel?: string;
  group?: string;
  title?: string;
  disabled?: boolean;
}

export interface FormSelectProps {
  value: string | number;
  options: readonly FormSelectOption[];
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  menuLayout?: MenuLayout;
  menuMinWidth?: number;
  style?: CSSProperties;
  title?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

type MenuPlacement = 'above' | 'below';
type MenuLayout = 'default' | 'dual-pane';

interface MenuPosition {
  left: number;
  width: number;
  maxHeight: number;
  placement: MenuPlacement;
  top?: number;
  bottom?: number;
}

const MENU_GAP = 2;
const VIEWPORT_PADDING = 8;
const PREFERRED_MENU_HEIGHT = 280;
const MIN_MENU_HEIGHT = 112;

export function FormSelect({
  value,
  options,
  onChange,
  id,
  placeholder = '请选择',
  disabled = false,
  className,
  menuLayout = 'default',
  menuMinWidth,
  style,
  title,
  'aria-label': ariaLabel,
  'data-testid': dataTestId,
}: FormSelectProps) {
  const generatedId = useId();
  const controlId = id ?? `form-select-${generatedId}`;
  const listboxId = `${controlId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef('');
  const typeaheadTimeoutRef = useRef<number | undefined>(undefined);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const selectedValue = String(value);
  const selectedIndex = options.findIndex((option) => String(option.value) === selectedValue);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const selectedDisplayLabel = selectedOption?.selectedLabel ?? selectedOption?.label;
  const triggerClassName = ['form-select', className].filter(Boolean).join(' ');
  const isDualPane = menuLayout === 'dual-pane' && options.some((option) => option.group);
  const groupedOptions = useMemo(() => (
    isDualPane
      ? [...options.reduce((groups, option, index) => {
        if (!option.group) return groups;
        const indexes = groups.get(option.group) ?? [];
        indexes.push(index);
        groups.set(option.group, indexes);
        return groups;
      }, new Map<string, number[]>())]
      : []
  ), [isDualPane, options]);
  const firstGroup = groupedOptions[0]?.[0] ?? null;
  const effectiveActiveGroup = isDualPane
    ? activeGroup ?? selectedOption?.group ?? firstGroup
    : null;
  const visibleOptionIndexes = useMemo(() => (
    isDualPane && effectiveActiveGroup
      ? groupedOptions.find(([group]) => group === effectiveActiveGroup)?.[1] ?? []
      : options.map((_, index) => index)
  ), [effectiveActiveGroup, groupedOptions, isDualPane, options]);

  const optionId = useCallback((index: number) => `${controlId}-option-${index}`, [controlId]);

  const findEnabledIndex = useCallback((startIndex: number, direction: 1 | -1) => {
    if (options.length === 0) return -1;

    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (startIndex + (offset * direction) + options.length) % options.length;
      if (!options[index]?.disabled) return index;
    }

    return -1;
  }, [options]);

  const findEnabledIndexIn = useCallback((indexes: number[], startPosition: number, direction: 1 | -1) => {
    if (indexes.length === 0) return -1;

    for (let offset = 0; offset < indexes.length; offset += 1) {
      const position = (startPosition + (offset * direction) + indexes.length) % indexes.length;
      const index = indexes[position];
      if (!options[index]?.disabled) return index;
    }

    return -1;
  }, [options]);

  const findFirstEnabledIndexForGroup = useCallback((group: string | null) => {
    const indexes = group
      ? groupedOptions.find(([groupName]) => groupName === group)?.[1] ?? []
      : options.map((_, index) => index);
    return findEnabledIndexIn(indexes, 0, 1);
  }, [findEnabledIndexIn, groupedOptions, options]);

  const findEnabledVisibleIndex = useCallback((currentIndex: number, direction: 1 | -1) => {
    if (!isDualPane) return findEnabledIndex(
      currentIndex >= 0 ? currentIndex + direction : (direction === 1 ? 0 : options.length - 1),
      direction,
    );
    const currentPosition = visibleOptionIndexes.indexOf(currentIndex);
    const startPosition = currentPosition >= 0
      ? currentPosition + direction
      : direction === 1 ? 0 : visibleOptionIndexes.length - 1;
    return findEnabledIndexIn(visibleOptionIndexes, startPosition, direction);
  }, [findEnabledIndex, findEnabledIndexIn, isDualPane, options.length, visibleOptionIndexes]);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setMenuPosition(null);
    typeaheadRef.current = '';
    if (typeaheadTimeoutRef.current !== undefined) {
      window.clearTimeout(typeaheadTimeoutRef.current);
      typeaheadTimeoutRef.current = undefined;
    }
  }, []);

  useOutsidePointerDown(triggerRef, closeMenu, [menuRef]);

  useEffect(() => () => {
    if (typeaheadTimeoutRef.current !== undefined) {
      window.clearTimeout(typeaheadTimeoutRef.current);
    }
  }, []);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - VIEWPORT_PADDING;
    const spaceAbove = rect.top - MENU_GAP - VIEWPORT_PADDING;
    const placement: MenuPlacement = spaceBelow >= MIN_MENU_HEIGHT || spaceBelow >= spaceAbove ? 'below' : 'above';
    const availableHeight = placement === 'below' ? spaceBelow : spaceAbove;
    const preferredHeight = menuLayout === 'dual-pane' ? 400 : PREFERRED_MENU_HEIGHT;
    const maxHeight = Math.max(MIN_MENU_HEIGHT, Math.min(preferredHeight, availableHeight));
    const width = Math.max(0, Math.min(Math.max(rect.width, menuMinWidth ?? 0), viewportWidth - (VIEWPORT_PADDING * 2)));
    const left = Math.min(Math.max(VIEWPORT_PADDING, rect.left), Math.max(VIEWPORT_PADDING, viewportWidth - width - VIEWPORT_PADDING));

    setMenuPosition({
      left,
      width,
      maxHeight,
      placement,
      ...(placement === 'below'
        ? { top: rect.bottom + MENU_GAP }
        : { bottom: viewportHeight - rect.top + MENU_GAP }),
    });
  }, [menuLayout, menuMinWidth]);

  useLayoutEffect(() => {
    if (!isOpen) return undefined;

    updateMenuPosition();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(updateMenuPosition);
    if (triggerRef.current) resizeObserver?.observe(triggerRef.current);

    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen || activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, isOpen, optionId]);

  useEffect(() => {
    if (!isDualPane) {
      if (activeGroup !== null) setActiveGroup(null);
      return;
    }
    if (activeGroup && groupedOptions.some(([group]) => group === activeGroup)) return;
    const nextGroup = selectedOption?.group ?? firstGroup;
    if (activeGroup !== nextGroup) setActiveGroup(nextGroup);
  }, [activeGroup, firstGroup, groupedOptions, isDualPane, selectedOption?.group]);

  useEffect(() => {
    setActiveIndex((currentIndex) => {
      const indexes = isDualPane ? visibleOptionIndexes : options.map((_, index) => index);
      if (indexes.includes(currentIndex) && !options[currentIndex]?.disabled) {
        return currentIndex;
      }
      if (indexes.includes(selectedIndex) && !options[selectedIndex]?.disabled) return selectedIndex;
      return findEnabledIndexIn(indexes, 0, 1);
    });
  }, [findEnabledIndexIn, isDualPane, options, selectedIndex, visibleOptionIndexes]);

  const openMenu = useCallback((preferredIndex?: number) => {
    const preferredOption = preferredIndex === undefined ? selectedIndex : preferredIndex;
    let nextIndex = preferredOption >= 0 && !options[preferredOption]?.disabled
      ? preferredOption
      : findEnabledIndex(preferredOption >= 0 ? preferredOption : 0, 1);
    if (isDualPane) {
      const nextGroup = options[nextIndex]?.group ?? selectedOption?.group ?? firstGroup;
      setActiveGroup(nextGroup);
      if (nextGroup && options[nextIndex]?.group !== nextGroup) {
        nextIndex = findFirstEnabledIndexForGroup(nextGroup);
      }
    }
    setActiveIndex(nextIndex);
    setIsOpen(true);
  }, [findEnabledIndex, findFirstEnabledIndexForGroup, firstGroup, isDualPane, options, selectedIndex, selectedOption?.group]);

  const moveActive = useCallback((direction: 1 | -1) => {
    setActiveIndex((currentIndex) => findEnabledVisibleIndex(currentIndex, direction));
  }, [findEnabledVisibleIndex]);

  const selectIndex = useCallback((index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;

    onChange(String(option.value));
    closeMenu();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, [closeMenu, onChange, options]);

  const moveToBoundary = useCallback((direction: 1 | -1) => {
    const indexes = isDualPane ? visibleOptionIndexes : options.map((_, index) => index);
    setActiveIndex(findEnabledIndexIn(indexes, direction === 1 ? 0 : indexes.length - 1, direction));
  }, [findEnabledIndexIn, isDualPane, options, visibleOptionIndexes]);

  const handleTypeahead = useCallback((key: string) => {
    const query = `${typeaheadRef.current}${key}`.toLocaleLowerCase();
    typeaheadRef.current = query;
    if (typeaheadTimeoutRef.current !== undefined) window.clearTimeout(typeaheadTimeoutRef.current);
    typeaheadTimeoutRef.current = window.setTimeout(() => {
      typeaheadRef.current = '';
      typeaheadTimeoutRef.current = undefined;
    }, 600);

    const startIndex = activeIndex >= 0 ? activeIndex + 1 : 0;
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (startIndex + offset) % options.length;
      const option = options[index];
      if (!option?.disabled && (!isDualPane || option.group) && option.label.toLocaleLowerCase().startsWith(query)) {
        if (isDualPane && option.group) setActiveGroup(option.group);
        setActiveIndex(index);
        if (!isOpen) setIsOpen(true);
        return;
      }
    }
  }, [activeIndex, isDualPane, isOpen, options]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (isOpen) moveActive(1);
      else openMenu();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (isOpen) moveActive(-1);
      else openMenu(options.length - 1);
      return;
    }

    if (event.key === 'Home' && isOpen) {
      event.preventDefault();
      moveToBoundary(1);
      return;
    }

    if (event.key === 'End' && isOpen) {
      event.preventDefault();
      moveToBoundary(-1);
      return;
    }

    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      closeMenu();
      return;
    }

    if (event.key === 'Tab' && isOpen) {
      closeMenu();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (isOpen && activeIndex >= 0) selectIndex(activeIndex);
      else openMenu();
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      handleTypeahead(event.key);
    }
  };

  const selectGroup = (group: string, indexes: number[]) => {
    setActiveGroup(group);
    setActiveIndex(findEnabledIndexIn(indexes, 0, 1));
  };
  const renderOptions = (indexes: number[], showGroups: boolean) => (
    <>
      {indexes.length === 0 ? (
        <div className="form-select__empty">没有可用选项</div>
      ) : indexes.map((index, displayIndex) => {
        const option = options[index];
        const isSelected = index === selectedIndex;
        const isActive = index === activeIndex;
        const previousIndex = displayIndex > 0 ? indexes[displayIndex - 1] : undefined;
        const previousGroup = previousIndex === undefined ? undefined : options[previousIndex]?.group;
        const showGroup = showGroups && option?.group && option.group !== previousGroup;
        return (
          <div key={String(option.value)}>
            {showGroup && <div className="form-select__group" role="presentation">{option.group}</div>}
            <div
              id={optionId(index)}
              className="form-select__option"
              role="option"
              aria-selected={isSelected}
              aria-disabled={option.disabled || undefined}
              data-active={isActive || undefined}
              data-disabled={option.disabled || undefined}
              title={option.title ?? option.selectedLabel ?? option.label}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => {
                if (!option.disabled) setActiveIndex(index);
              }}
              onClick={() => selectIndex(index)}
            >
              <span className="form-select__option-label">{option.label}</span>
              {isSelected && <IconCheck className="form-select__option-check" width={14} height={14} aria-hidden="true" />}
            </div>
          </div>
        );
      })}
    </>
  );
  const listbox = isOpen && typeof document !== 'undefined' ? createPortal(
    <div
      ref={menuRef}
      id={isDualPane ? undefined : listboxId}
      className={`form-select__menu${isDualPane ? ' form-select__menu--dual-pane' : ''}`}
      role={isDualPane ? undefined : 'listbox'}
      aria-label={isDualPane ? undefined : (ariaLabel ? `${ariaLabel}选项` : '可选项')}
      data-placement={menuPosition?.placement ?? 'below'}
      data-layout={isDualPane ? 'dual-pane' : undefined}
      style={menuPosition ?? { visibility: 'hidden' }}
    >
      {isDualPane ? (
        <>
          <div className="form-select__group-pane custom-scrollbar" role="listbox" aria-label="选项分组">
            {groupedOptions.map(([group, indexes]) => (
              <button
                key={group}
                type="button"
                role="option"
                aria-selected={effectiveActiveGroup === group}
                className="form-select__group-button"
                data-active={effectiveActiveGroup === group || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  selectGroup(group, indexes);
                }}
                title={group}
              >
                {group}
              </button>
            ))}
          </div>
          <div id={listboxId} className="form-select__option-pane custom-scrollbar" role="listbox" aria-label={ariaLabel ? `${ariaLabel}选项` : '可选项'}>
            {renderOptions(visibleOptionIndexes, false)}
          </div>
        </>
      ) : renderOptions(options.map((_, index) => index), true)}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        id={controlId}
        type="button"
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-activedescendant={isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        className={triggerClassName}
        data-open={isOpen || undefined}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
        style={style}
        title={title ?? selectedOption?.title ?? selectedDisplayLabel}
      >
        <span className="form-select__value">{selectedDisplayLabel ?? placeholder}</span>
        <IconChevronDown className="form-select__chevron" width={14} height={14} aria-hidden="true" />
      </button>
      {listbox}
    </>
  );
}
