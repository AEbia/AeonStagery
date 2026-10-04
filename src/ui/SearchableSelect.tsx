import { useState, useMemo, useRef, useEffect, useId, useCallback } from 'react';
import { IconSearch, IconX, IconChevronDown, IconPlay, IconRefresh } from './icons';
import { useOutsidePointerDown } from './hooks/useOutsidePointerDown';

export interface Option {
  value: string;
  label: string;
  group?: string;
  primaryGroup?: string;
  secondaryGroup?: string;
}

export interface SearchableSelectProps {
  value: string;
  options: string[] | Option[];
  onChange: (val: string) => void;
  placeholder?: string;
  label?: string;
  loading?: boolean;
  header?: string;
  footer?: React.ReactNode;
  /** Explicit preview only: invoked by the per-row play button, never by hover or keyboard browsing. */
  onPreview?: (val: string) => void;
  dataTestId?: string;
  clearable?: boolean;
  clearLabel?: string;
  preferredGroup?: string;
  costumeHint?: string;
}

const MAX_SEARCH_RESULTS = 100;

export const SearchableSelect = ({
  value,
  options,
  onChange,
  placeholder = "搜索…",
  label,
  loading,
  header,
  footer,
  onPreview,
  dataTestId,
  clearable,
  clearLabel,
  preferredGroup,
}: SearchableSelectProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activePrimaryGroup, setActivePrimaryGroup] = useState<string | null>(null);
  const [activeSecondaryGroup, setActiveSecondaryGroup] = useState<string | null>(null);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const controlId = useId();
  const labelId = `${controlId}-label`;
  const listboxId = `${controlId}-listbox`;

  const normalizedOptions = useMemo(() => {
    return options.map(opt => {
      if (typeof opt === 'string') {
        const parts = opt.split('/');
        if (parts.length >= 3) {
          return {
            value: opt,
            label: opt,
            group: parts.slice(0, -1).join('/'),
            primaryGroup: parts[0],
            secondaryGroup: parts[1],
          };
        }
        if (parts.length === 2) {
          return {
            value: opt,
            label: opt,
            group: parts[0],
            primaryGroup: parts[0],
            secondaryGroup: undefined,
          };
        }
        return {
          value: opt,
          label: opt,
          group: '默认',
          primaryGroup: '默认',
          secondaryGroup: undefined,
        };
      }
      if (typeof opt === 'object' && opt !== null) {
        if (!opt.primaryGroup && opt.value) {
          const parts = opt.value.split('/');
          if (parts.length >= 3) {
            return {
              ...opt,
              group: opt.group || parts.slice(0, -1).join('/'),
              primaryGroup: parts[0],
              secondaryGroup: parts[1],
            };
          }
          if (parts.length === 2) {
            return {
              ...opt,
              group: opt.group || parts[0],
              primaryGroup: parts[0],
              secondaryGroup: undefined,
            };
          }
        }
        return {
          ...opt,
          primaryGroup: opt.primaryGroup || opt.group || '默认',
          secondaryGroup: opt.secondaryGroup,
        };
      }
      return opt;
    });
  }, [options]);

  const primaryGroups = useMemo(() => {
    const set = new Set<string>();
    normalizedOptions.forEach(opt => {
      if (opt.primaryGroup) set.add(opt.primaryGroup);
    });
    return Array.from(set).sort();
  }, [normalizedOptions]);

  const currentSecondaryGroups = useMemo(() => {
    if (!activePrimaryGroup) return [];
    const set = new Set<string>();
    let hasUnassigned = false;
    normalizedOptions.forEach(opt => {
      if (opt.primaryGroup === activePrimaryGroup) {
        if (opt.secondaryGroup) {
          set.add(opt.secondaryGroup);
        } else {
          hasUnassigned = true;
        }
      }
    });
    const result = Array.from(set).sort();
    if (result.length > 0 && hasUnassigned) {
      result.unshift('其他');
    }
    return result;
  }, [normalizedOptions, activePrimaryGroup]);

  const hasSecondary = currentSecondaryGroups.length > 0;

  const filteredOptions = useMemo(() => {
    const s = search.toLowerCase().trim();
    if (!s) return normalizedOptions;
    const tokens = s.split(/\s+/).filter(Boolean);
    return normalizedOptions.filter(opt => {
      const target = `${opt.label} ${opt.value} ${opt.group || ''}`.toLowerCase();
      return tokens.every(token => target.includes(token));
    });
  }, [normalizedOptions, search]);

  const resolveTargetGroups = useCallback(() => {
    if (primaryGroups.length === 0) {
      return { primary: null, secondary: null };
    }

    // 1. Current value in options
    const currentOpt = normalizedOptions.find(o => o.value === value);
    if (currentOpt) {
      return {
        primary: currentOpt.primaryGroup,
        secondary: currentOpt.secondaryGroup || null,
      };
    }

    // 2. preferredGroup
    let targetPrimary: string | undefined;
    let targetSecondary: string | undefined;
    if (preferredGroup) {
      const parts = preferredGroup.split('/');
      if (primaryGroups.includes(parts[0])) {
        targetPrimary = parts[0];
        targetSecondary = parts.length >= 2 ? parts.slice(1).join('/') : undefined;
      } else {
        const match = normalizedOptions.find(o => o.secondaryGroup === preferredGroup);
        if (match && primaryGroups.includes(match.primaryGroup)) {
          targetPrimary = match.primaryGroup;
          targetSecondary = match.secondaryGroup;
        }
      }
    }

    // 3. Fallback to first primaryGroup
    if (!targetPrimary) {
      targetPrimary = primaryGroups[0];
    }

    const validSecondaries = Array.from(new Set(
      normalizedOptions
        .filter(o => o.primaryGroup === targetPrimary && o.secondaryGroup)
        .map(o => o.secondaryGroup!)
    )).sort();

    if (validSecondaries.length === 0) {
      return { primary: targetPrimary, secondary: null };
    }

    if (targetSecondary && validSecondaries.includes(targetSecondary)) {
      return { primary: targetPrimary, secondary: targetSecondary };
    }

    return { primary: targetPrimary, secondary: validSecondaries[0] };
  }, [primaryGroups, normalizedOptions, value, preferredGroup]);

  // Initialize or reset groups when dropdown opens or when options/value change from outside
  useEffect(() => {
    if (isOpen) {
      const { primary, secondary } = resolveTargetGroups();
      setActivePrimaryGroup(primary);
      setActiveSecondaryGroup(secondary);
    }
  }, [isOpen, resolveTargetGroups]);

  const prevOptionsRef = useRef(options);
  useEffect(() => {
    if (prevOptionsRef.current !== options) {
      prevOptionsRef.current = options;
      const { primary, secondary } = resolveTargetGroups();
      setActivePrimaryGroup(primary);
      setActiveSecondaryGroup(secondary);
    }
  }, [options, resolveTargetGroups]);

  const prevValueRef = useRef(value);
  useEffect(() => {
    if (prevValueRef.current !== value) {
      prevValueRef.current = value;
      const { primary, secondary } = resolveTargetGroups();
      setActivePrimaryGroup(primary);
      setActiveSecondaryGroup(secondary);
    }
  }, [value, resolveTargetGroups]);

  // Safety fallback if activePrimaryGroup becomes invalid
  useEffect(() => {
    if (activePrimaryGroup && !primaryGroups.includes(activePrimaryGroup)) {
      const { primary, secondary } = resolveTargetGroups();
      setActivePrimaryGroup(primary);
      setActiveSecondaryGroup(secondary);
    }
  }, [primaryGroups, activePrimaryGroup, resolveTargetGroups]);

  // Safety fallback if activeSecondaryGroup becomes invalid under current primary
  useEffect(() => {
    if (activePrimaryGroup && currentSecondaryGroups.length > 0) {
      if (!activeSecondaryGroup || (!currentSecondaryGroups.includes(activeSecondaryGroup) && activeSecondaryGroup !== '其他')) {
        setActiveSecondaryGroup(currentSecondaryGroups[0]);
      }
    }
  }, [activePrimaryGroup, currentSecondaryGroups, activeSecondaryGroup]);

  const displayedOptions = useMemo(() => {
    let opts = filteredOptions;
    if (!search && activePrimaryGroup) {
      if (currentSecondaryGroups.length > 0) {
        if (activeSecondaryGroup === '其他') {
          opts = opts.filter(
            o => o.primaryGroup === activePrimaryGroup && !o.secondaryGroup
          );
        } else if (activeSecondaryGroup) {
          opts = opts.filter(
            o => o.primaryGroup === activePrimaryGroup && o.secondaryGroup === activeSecondaryGroup
          );
        } else {
          opts = opts.filter(o => o.primaryGroup === activePrimaryGroup);
        }
      } else {
        opts = opts.filter(o => o.primaryGroup === activePrimaryGroup);
      }
    }

    // Priority: current selected value first within its group
    if (value) {
      const selectedIdx = opts.findIndex(o => o.value === value);
      if (selectedIdx !== -1) {
        const result = [...opts];
        const [selected] = result.splice(selectedIdx, 1);
        opts = [selected, ...result];
      }
    }

    if (clearable) {
      const emptyLabel = clearLabel || '（无）';
      const matchSearch = !search
        || emptyLabel.toLowerCase().includes(search.toLowerCase())
        || '无'.includes(search.toLowerCase());
      if (matchSearch) {
        const clearOption = {
          value: '',
          label: emptyLabel,
          primaryGroup: '默认',
          secondaryGroup: undefined,
        };
        if (value && opts.length > 0 && opts[0].value === value) {
          opts = [opts[0], clearOption, ...opts.slice(1)];
        } else {
          opts = [clearOption, ...opts];
        }
      }
    }

    if (search && opts.length > MAX_SEARCH_RESULTS) {
      opts = opts.slice(0, MAX_SEARCH_RESULTS);
    }

    return opts;
  }, [filteredOptions, search, activePrimaryGroup, currentSecondaryGroups.length, activeSecondaryGroup, value, clearable, clearLabel]);

  const previewActiveRef = useRef(false);
  const restorePreview = useCallback(() => {
    if (onPreview && previewActiveRef.current) {
      previewActiveRef.current = false;
      onPreview(value);
    }
  }, [onPreview, value]);
  const restorePreviewRef = useRef(restorePreview);
  restorePreviewRef.current = restorePreview;

  useEffect(() => {
    return () => {
      restorePreviewRef.current();
    };
  }, []);

  const closeSelect = useCallback(() => {
    restorePreview();
    setIsOpen(false);
  }, [restorePreview]);
  useOutsidePointerDown(containerRef, closeSelect);

  useEffect(() => {
    setActiveOptionIndex((current) => Math.min(current, Math.max(0, displayedOptions.length - 1)));
  }, [displayedOptions.length]);

  useEffect(() => {
    if (!isOpen || activeOptionIndex < 0) return;
    const optionEl = document.getElementById(`${controlId}-option-${activeOptionIndex}`);
    optionEl?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionIndex, controlId, isOpen]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const overlay = containerRef.current?.querySelector('.searchable-select-overlay') as HTMLElement | null;
          let panel: Element | null = containerRef.current?.parentElement ?? null;
          while (panel) {
            const style = window.getComputedStyle(panel);
            const overflowY = style.overflowY;
            if (overflowY === 'auto' || overflowY === 'scroll') break;
            panel = panel.parentElement;
          }
          if (panel && overlay) {
            const panelRect = panel.getBoundingClientRect();
            const overlayBottom = overlay.getBoundingClientRect().bottom;
            if (overlayBottom > panelRect.bottom) {
              panel.scrollTop += (overlayBottom - panelRect.bottom) + 20;
            }
          }
        });
      });
    }
  }, [isOpen]);

  const selectedOption = normalizedOptions.find(opt => opt.value === value);
  const displayValue = selectedOption ? selectedOption.label : (value || placeholder);
  const selectOption = (nextValue: string) => {
    previewActiveRef.current = false;
    onChange(nextValue);
    setIsOpen(false);
    setSearch('');
    triggerRef.current?.focus();
  };
  const openSelect = () => {
    const { primary, secondary } = resolveTargetGroups();
    setActivePrimaryGroup(primary);
    setActiveSecondaryGroup(secondary);
    const selectedIndex = displayedOptions.findIndex((option) => option.value === value);
    setActiveOptionIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setIsOpen(true);
  };
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      restorePreview();
      setIsOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = displayedOptions.length === 0
        ? 0
        : (activeOptionIndex + direction + displayedOptions.length) % displayedOptions.length;
      setActiveOptionIndex(nextIndex);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : Math.max(0, displayedOptions.length - 1);
      setActiveOptionIndex(nextIndex);
      return;
    }
    if (event.key === 'Enter' && displayedOptions[activeOptionIndex]) {
      event.preventDefault();
      selectOption(displayedOptions[activeOptionIndex].value);
    }
  };

  const hasGroups = primaryGroups.length > 1 || (primaryGroups.length === 1 && primaryGroups[0] !== '默认');

  return (
    <div className="inspector-row" ref={containerRef} style={{ position: 'relative' }}>
      {label && <label id={labelId} htmlFor={controlId} className="inspector-label">{label}</label>}
      <button
        ref={triggerRef}
        id={controlId}
        type="button"
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : placeholder}
        className={`form-select-trigger ${isOpen ? 'active' : ''}`}
        data-testid={dataTestId}
        onClick={() => isOpen ? closeSelect() : openSelect()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!isOpen) openSelect();
          } else if (event.key === 'Escape' && isOpen) {
            event.preventDefault();
            restorePreview();
            setIsOpen(false);
          }
        }}
        style={{
          width: '100%',
          color: 'inherit',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          borderRadius: isOpen ? 'var(--radius-sm, 4px) var(--radius-sm, 4px) 0 0' : 'var(--radius-sm, 4px)',
          cursor: 'pointer',
          fontSize: '12px',
          fontWeight: 500,
          transition: 'background-color 0.2s, border-color 0.2s, color 0.2s',
          minHeight: '32px'
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: value ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', gap: 6, flex: 1 }}>
          {loading ? <><IconRefresh width={12} height={12} /> 加载中…</> : displayValue}
        </span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: '8px' }}>
          {clearable && Boolean(value) && (
            <span
              role="button"
              tabIndex={0}
              aria-label={`清除${label || '选择'}`}
              title={`清除${label || '选择'}`}
              onClick={(e) => {
                e.stopPropagation();
                restorePreview();
                onChange('');
                triggerRef.current?.focus();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  restorePreview();
                  onChange('');
                  triggerRef.current?.focus();
                }
              }}
              style={{
                opacity: 0.6,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '2px',
                cursor: 'pointer',
                borderRadius: 'var(--radius-sm, 2px)',
                lineHeight: 1,
              }}
              className="searchable-select__clear-btn"
            >
              <IconX width={12} height={12} />
            </span>
          )}
          <IconChevronDown width={14} height={14} style={{ opacity: 0.5 }} />
        </div>
      </button>

      {isOpen && (
        <div className="searchable-select-overlay dual-pane" style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          marginTop: 0,
          background: 'var(--bg-elevated)',
          backdropFilter: 'blur(24px)',
          border: '1px solid var(--border-highlight)',
          borderTop: 'none',
          borderRadius: '0 0 var(--radius-sm, 4px) var(--radius-sm, 4px)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 1000,
          maxHeight: '360px',
          height: 'min(360px, 60vh)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          {/* Context Header */}
          {header && (
            <div style={{ 
              padding: '6px 12px', 
              background: 'var(--accent-glow)', 
              color: 'var(--accent-primary)',
              fontSize: '10px',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              letterSpacing: '1px',
              borderBottom: '1px solid var(--border-highlight)'
            }}>
              {header}
            </div>
          )}

          {/* Search Header */}
          <div style={{ padding: '10px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <IconSearch width={16} height={16} style={{ opacity: 0.5 }} />
            <input 
              ref={inputRef}
              type="text" 
              role="searchbox"
              name={`${controlId}-search`}
              autoComplete="off"
              aria-label="搜索选项"
              aria-controls={listboxId}
              aria-activedescendant={displayedOptions[activeOptionIndex] ? `${controlId}-option-${activeOptionIndex}` : undefined}
              placeholder="搜索动作名称或分组…"
              value={search}
              onChange={e => {
                setSearch(e.target.value);
                setActiveOptionIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'transparent',
                border: 'none',
                padding: '4px 0',
                fontSize: '13px',
                flex: 1,
                outline: 'none',
                color: 'var(--text-primary)'
              }}
            />
            {search && (
              <button
                type="button"
                className="btn btn--icon"
                aria-label="清除搜索"
                onClick={(e) => { e.stopPropagation(); setSearch(''); inputRef.current?.focus(); }}
                style={{ width: 24, height: 24, opacity: 0.5 }}
              >
                <IconX width={16} height={16} />
              </button>
            )}
          </div>

          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {/* Column 1: Primary Group (Group Column in dual-pane or Level 1 in tri-pane) */}
            {!search && hasGroups && (
              <div
                style={{
                  width: hasSecondary ? '74px' : '120px',
                  borderRight: '1px solid var(--border-subtle)',
                  overflowY: 'auto',
                  background: 'rgba(0,0,0,0.1)',
                  padding: '4px',
                  flexShrink: 0,
                }}
                className="custom-scrollbar"
                role="listbox"
                aria-label={hasSecondary ? '一级分组' : '选项分组'}
              >
                {primaryGroups.map(pGroup => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={activePrimaryGroup === pGroup}
                    key={pGroup}
                    title={pGroup}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActivePrimaryGroup(pGroup);
                      const validSecondaries = Array.from(new Set(
                        normalizedOptions
                          .filter(o => o.primaryGroup === pGroup && o.secondaryGroup)
                          .map(o => o.secondaryGroup!)
                      )).sort();
                      const prefSec = preferredGroup?.split('/')?.[1];
                      if (prefSec && validSecondaries.includes(prefSec)) {
                        setActiveSecondaryGroup(prefSec);
                      } else {
                        setActiveSecondaryGroup(validSecondaries[0] || null);
                      }
                      setActiveOptionIndex(0);
                      inputRef.current?.focus();
                    }}
                    className="searchable-select__group"
                    data-active={activePrimaryGroup === pGroup || undefined}
                    style={{
                      display: 'block',
                      width: '100%',
                      border: 0,
                      textAlign: 'left',
                      padding: hasSecondary ? '7px 6px' : '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      marginBottom: '2px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontSize: '11px',
                    }}
                  >
                    {pGroup}
                  </button>
                ))}
              </div>
            )}

            {/* Column 2: Secondary Group (rendered ONLY when current primary group has secondary groups and not searching) */}
            {!search && hasSecondary && (
              <div
                style={{
                  width: '74px',
                  borderRight: '1px solid var(--border-subtle)',
                  overflowY: 'auto',
                  background: 'rgba(0,0,0,0.06)',
                  padding: '4px',
                  flexShrink: 0,
                }}
                className="custom-scrollbar"
                role="listbox"
                aria-label="二级分组"
              >
                {currentSecondaryGroups.map(sGroup => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={activeSecondaryGroup === sGroup}
                    key={sGroup}
                    title={sGroup}
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveSecondaryGroup(sGroup);
                      setActiveOptionIndex(0);
                      inputRef.current?.focus();
                    }}
                    className="searchable-select__group"
                    data-active={activeSecondaryGroup === sGroup || undefined}
                    style={{
                      display: 'block',
                      width: '100%',
                      border: 0,
                      textAlign: 'left',
                      padding: '7px 6px',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      marginBottom: '2px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontSize: '11px',
                    }}
                  >
                    {sGroup}
                  </button>
                ))}
              </div>
            )}

            {/* Options Pane */}
            <div
              id={listboxId}
              role="listbox"
              aria-label="可选项"
              onMouseLeave={restorePreview}
              style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '6px' }}
              className="custom-scrollbar"
            >
              {options.length === 0 && (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                  {loading ? '正在获取动作列表…' : '未发现可用数据'}
                </div>
              )}

              {options.length > 0 && displayedOptions.length === 0 && (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                  无匹配项
                </div>
              )}

              {displayedOptions.map((opt, index) => (
                <div
                  key={opt.value}
                  className={`searchable-option ${value === opt.value ? 'selected' : ''}`}
                  role="presentation"
                  data-active={activeOptionIndex === index || undefined}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 'var(--radius-sm)',
                    marginBottom: '2px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <button
                    id={`${controlId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={value === opt.value}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveOptionIndex(index)}
                    onClick={() => selectOption(opt.value)}
                    className="searchable-option__button"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      border: 0,
                      color: 'inherit',
                      background: 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                      padding: '3px 0',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    <span className="searchable-option__label" style={{ overflowWrap: 'anywhere' }}>
                      {/* Option rows hide the slash prefix (a/b -> b); the trigger combobox keeps the full key. */}
                      {opt.label.split('/').pop()}
                    </span>
                    {search && opt.group && (
                      <span className="searchable-option__meta">{opt.group}</span>
                    )}
                  </button>
                  {onPreview && Boolean(opt.value) && (
                    <button
                      className="btn btn--icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        previewActiveRef.current = true;
                        onPreview(opt.value);
                      }}
                      title="预览"
                      aria-label={`预览 ${opt.label}`}
                      style={{ width: 22, height: 22, flexShrink: 0, fontSize: 10 }}
                    >
                      <IconPlay width={10} height={10} />
                    </button>
                  )}
                </div>
              ))}

              {search && filteredOptions.length > MAX_SEARCH_RESULTS && (
                <div style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', borderTop: '1px solid var(--border-subtle)' }}>
                  已显示前 {MAX_SEARCH_RESULTS} 条匹配项，共 {filteredOptions.length} 条
                </div>
              )}
            </div>

            {footer && (
              <div style={{ borderTop: '1px solid var(--border-subtle)', padding: 6 }}>
                {footer}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
