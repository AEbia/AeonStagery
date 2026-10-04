import React, { useEffect, useRef, useState } from 'react';
import type { SourcedSemanticAuthoringCombo } from '../services/template-package';
import { IconSearch, IconStar, IconX } from './icons';
import { useOptionalApp } from './context/AppContext';
import { showToast } from './Toast';
import { ActionIcons } from './timeline/TimelineConstants';
import {
  NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS,
  SEMANTIC_STATEMENT_BLOCKS,
  type SemanticStatementBlockEntry,
} from './timeline/semanticStatementBlocks';

const RECENT_STORAGE_KEY = 'aeonstagery.statementBlockLibrary.recent';
const MAX_RECENT_ITEMS = 6;
type RecentLibraryItem = {
  type: 'statement' | 'template';
  id: string;
};

const readRecentItems = (): RecentLibraryItem[] => {
  if (typeof window === 'undefined') return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is RecentLibraryItem =>
      item &&
      (item.type === 'statement' || item.type === 'template') &&
      typeof item.id === 'string',
    ).slice(0, MAX_RECENT_ITEMS);
  } catch {
    return [];
  }
};

const EXISTING_BLOCK_LABELS = new Set(SEMANTIC_STATEMENT_BLOCKS.map(b => b.label));

export const isMultiStatementCombo = (t: SourcedSemanticAuthoringCombo): boolean => {
  if (t.payload) {
    switch (t.payload.kind) {
      case 'statementPreset':
        return false;
      case 'dialoguePreset':
        return (t.payload.companions?.length ?? 0) > 0;
      case 'timelineFragment':
        return (
          (t.payload.statements?.length ?? 0) > 1 ||
          ((t.payload.statements?.[0] as any)?.companions?.length ?? 0) > 0
        );
      default:
        break;
    }
    if (Array.isArray((t.payload as any).statements)) {
      return (t.payload as any).statements.length > 1;
    }
  }
  if (Array.isArray((t as any).statements)) {
    return (t as any).statements.length > 1;
  }
  if (Array.isArray((t as any).actions)) {
    return (t as any).actions.length > 1;
  }
  return false;
};

export const StatementBlockLibrary: React.FC<{
  onSelectAction?: (type: 'statement' | 'template', data: any) => void;
  templates?: SourcedSemanticAuthoringCombo[];
  style?: React.CSSProperties;
  className?: string;
  autoFocusSearch?: boolean;
  hideSearch?: boolean;
  hideDescriptions?: boolean;
  hiddenStatementBlockIds?: ReadonlySet<string>;
  search?: string;
  onSearchChange?: (value: string) => void;
  activeCategory?: string;
  availableLifecycleEndCommandIds?: ReadonlySet<string>;
  availableStateSpanDependencyCommandIds?: ReadonlySet<string>;
}> = ({
  onSelectAction,
  templates,
  style,
  className,
  autoFocusSearch = false,
  hideSearch = false,
  hideDescriptions = false,
  hiddenStatementBlockIds,
  search,
  onSearchChange,
  activeCategory = 'all',
  availableLifecycleEndCommandIds,
  availableStateSpanDependencyCommandIds,
}) => {
  const [internalSearch, setInternalSearch] = useState('');
  const [recentItems, setRecentItems] = useState<RecentLibraryItem[]>(() => readRecentItems());
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const app = useOptionalApp();
  const isOffline = app?.collaboration?.status === 'offline' || app?.collaboration?.status === 'reconnecting';
  const currentSearch = search ?? internalSearch;
  const availableTemplates = templates ?? [];

  useEffect(() => {
    if (!autoFocusSearch || hideSearch) return;
    requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
      searchInputRef.current?.select();
    });
  }, [autoFocusSearch, hideSearch]);

  const handleSearchChange = (value: string) => {
    setInternalSearch(value);
    onSearchChange?.(value);
  };

  // Filter cards by search query
  const showTemplates = activeCategory === 'all' || activeCategory === 'template';
  const filteredCombos = showTemplates
    ? availableTemplates
        .filter(t => isMultiStatementCombo(t) && !EXISTING_BLOCK_LABELS.has(t.name))
        .filter(t =>
          t.name.includes(currentSearch) ||
          t.id.includes(currentSearch) ||
          (t.source?.templateName ?? '').includes(currentSearch) ||
          (t.source?.templateId ?? '').includes(currentSearch),
        )
    : [];
  const filteredCards = SEMANTIC_STATEMENT_BLOCKS.filter((c) => {
    if (NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS.has(c.id)) return false;
    if (hiddenStatementBlockIds?.has(c.id)) return false;
    if (c.lifecycleEndCommand && availableLifecycleEndCommandIds && !availableLifecycleEndCommandIds.has(c.id)) return false;
    if (c.stateSpanDependencyCommand && availableStateSpanDependencyCommandIds && !availableStateSpanDependencyCommandIds.has(c.id)) return false;
    const categoryMatches = activeCategory === 'all' || c.category === activeCategory;
    const searchMatches =
      c.label.includes(currentSearch) ||
      c.id.includes(currentSearch) ||
      (!hideDescriptions && (c.description || '').includes(currentSearch));

    return categoryMatches && searchMatches;
  });

  // Group cards by category
  const groups = new Map<string, SemanticStatementBlockEntry[]>();
  for (const c of filteredCards) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category)!.push(c);
  }

  const categoryLabels: Record<string, string> = {
    dialogue: '对话',
    character: '角色',
    camera: '镜头',
    scene: '场景',
    visual: '画面效果',
    audio: '音频',
    layer: '图层',
  };

  const ORDERED_CATEGORY_IDS = [
    'dialogue',
    'character',
    'template',
    'camera',
    'scene',
    'visual',
    'audio',
    'layer',
  ] as const;

  const orderedCategoryIds = [
    ...ORDERED_CATEGORY_IDS,
    ...Array.from(groups.keys()).filter(cat => !(ORDERED_CATEGORY_IDS as readonly string[]).includes(cat)),
  ];

  const rememberRecent = (item: RecentLibraryItem) => {
    setRecentItems((items) => {
      const next = [item, ...items.filter(existing => existing.type !== item.type || existing.id !== item.id)]
        .slice(0, MAX_RECENT_ITEMS);
      try {
        window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage failures; selection should still work.
      }
      return next;
    });
  };

  // Click handlers instead of drag
  const handleSelect = (type: 'statement' | 'template', id: string, data: any) => {
    if (isOffline) {
      showToast('共享编辑已暂停；请重新加入后才能编辑。', 'warning');
      return;
    }
    rememberRecent({ type, id });
    if (onSelectAction) onSelectAction(type, data);
  };

  const recentEntries = recentItems
    .map(item => {
      if (item.type === 'template') {
        const template = availableTemplates.find(t => t.id === item.id);
        return template && isMultiStatementCombo(template) && !EXISTING_BLOCK_LABELS.has(template.name)
          ? { type: 'template' as const, template }
          : null;
      }

       const statement = SEMANTIC_STATEMENT_BLOCKS.find(c => (
         c.id === item.id
         && !NON_INSERTABLE_SEMANTIC_STATEMENT_BLOCK_IDS.has(c.id)
         && !hiddenStatementBlockIds?.has(c.id)
         && (!c.lifecycleEndCommand || !availableLifecycleEndCommandIds || availableLifecycleEndCommandIds.has(c.id))
         && (!c.stateSpanDependencyCommand || !availableStateSpanDependencyCommandIds || availableStateSpanDependencyCommandIds.has(c.id))
       ));
      return statement ? { type: 'statement' as const, statement } : null;
    })
    .filter(Boolean);

  const normalizedSearch = currentSearch.trim().toLowerCase();
  const visibleRecentEntries = normalizedSearch
    ? recentEntries.filter(entry => {
        if (!entry) return false;
        if (entry.type === 'template') {
          return (
            entry.template.name.toLowerCase().includes(normalizedSearch) ||
            entry.template.id.toLowerCase().includes(normalizedSearch)
          );
        }
        return (
          entry.statement.label.toLowerCase().includes(normalizedSearch) ||
          entry.statement.id.toLowerCase().includes(normalizedSearch) ||
          (!hideDescriptions && (entry.statement.description || '').toLowerCase().includes(normalizedSearch))
        );
      })
    : recentEntries;

  const showHistory = activeCategory === 'history';
  const hasVisibleCombos = filteredCombos.length > 0;
  const hasVisibleRecent = normalizedSearch ? visibleRecentEntries.length > 0 : recentEntries.length > 0;
  const totalVisibleItems = filteredCards.length + (showTemplates ? filteredCombos.length : 0);

  return (
    <div className={['statement-block-library', className].filter(Boolean).join(' ')} style={style}>
      {/* Search */}
      {!hideSearch && (
        <div className="statement-block-library__search">
          <div className="timeline-search">
            <IconSearch width={14} height={14} className="timeline-search__icon" />
            <input
              ref={searchInputRef}
              aria-label="搜索动作类型"
              placeholder="搜索动作类型..."
              value={currentSearch}
              onChange={e => handleSearchChange(e.target.value)}
            />
            {currentSearch && (
              <button
                type="button"
                className="timeline-search__clear"
                aria-label="清空搜索"
                title="清空搜索"
                onClick={() => {
                  handleSearchChange('');
                  searchInputRef.current?.focus();
                }}
              >
                <IconX width={12} height={12} />
              </button>
            )}
          </div>
        </div>
      )}

      {isOffline && (
        <div role="status" aria-live="polite" className="statement-block-library__offline-banner">
          共享编辑已暂停；重新加入后才能插入语句或组合。
        </div>
      )}

      <div className="statement-block-library__body">
        {showHistory && (
          <div className="statement-block-library__section">
            <div className="statement-block-library__section-title">最近使用</div>
            {visibleRecentEntries.length > 0 ? (
              <div className="statement-block-library__action-grid">
                {visibleRecentEntries.map(entry => {
                  if (!entry) return null;
                  if (entry.type === 'template') {
                    return (
                      <button
                        key={`template:${entry.template.id}`}
                        type="button"
                        className="statement-block-library__template statement-block-library__template--history"
                        data-testid="statement-template-card"
                        data-template-id={entry.template.id}
                        onClick={() => handleSelect('template', entry.template.id, { templateId: entry.template.id })}
                        title={entry.template.name}
                      >
                        <IconStar width={10} height={10} className="statement-block-library__template-icon" />
                        <span className="statement-block-library__template-label">{entry.template.name}</span>
                      </button>
                    );
                  }

                  const IconComp = (ActionIcons as any)[entry.statement.icon] || (ActionIcons as any).default;
                  return (
                    <button
                      key={`statement:${entry.statement.id}`}
                      type="button"
                      data-testid="statement-block-card"
                      data-block-id={entry.statement.id}
                      data-category={entry.statement.category}
                      className={[
                        'statement-block-library__action',
                        !hideDescriptions && entry.statement.description ? 'statement-block-library__action--has-description' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => handleSelect('statement', entry.statement.id, { blockId: entry.statement.id })}
                      title={!hideDescriptions && entry.statement.description
                        ? `${entry.statement.label} - ${entry.statement.description}`
                        : entry.statement.label}
                    >
                      <IconComp width={14} height={14} className="statement-block-library__action-icon" />
                      <div className="statement-block-library__action-content">
                        <span className="statement-block-library__action-label">{entry.statement.label}</span>
                        {!hideDescriptions && entry.statement.description && (
                          <span className="statement-block-library__action-description">
                            {entry.statement.description}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="statement-block-library__empty">
                {normalizedSearch ? `未找到与“${currentSearch}”匹配的历史记录` : '暂无历史，插入语句后会显示在这里'}
              </div>
            )}
          </div>
        )}

        {/* Action type cards and templates by category */}
        {!showHistory && (
          <>
            {activeCategory === 'all' && (
              <>
                {hasVisibleRecent && (
                  <div className="statement-block-library__section">
                    <div className="statement-block-library__section-title">最近使用</div>
                    <div className="statement-block-library__action-grid">
                      {visibleRecentEntries.map(entry => {
                        if (!entry) return null;
                        if (entry.type === 'template') {
                          return (
                            <button
                              key={`template:${entry.template.id}`}
                              type="button"
                              className="statement-block-library__template statement-block-library__template--history"
                              data-testid="statement-template-card"
                              data-template-id={entry.template.id}
                              onClick={() => handleSelect('template', entry.template.id, { templateId: entry.template.id })}
                              title={entry.template.name}
                            >
                              <IconStar width={10} height={10} className="statement-block-library__template-icon" />
                              <span className="statement-block-library__template-label">{entry.template.name}</span>
                            </button>
                          );
                        }

                        const IconComp = (ActionIcons as any)[entry.statement.icon] || (ActionIcons as any).default;
                        return (
                          <button
                            key={`statement:${entry.statement.id}`}
                            type="button"
                            data-testid="statement-block-card"
                            data-block-id={entry.statement.id}
                            data-category={entry.statement.category}
                            className={[
                              'statement-block-library__action',
                              !hideDescriptions && entry.statement.description ? 'statement-block-library__action--has-description' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => handleSelect('statement', entry.statement.id, { blockId: entry.statement.id })}
                            title={!hideDescriptions && entry.statement.description
                              ? `${entry.statement.label} - ${entry.statement.description}`
                              : entry.statement.label}
                          >
                            <IconComp width={14} height={14} className="statement-block-library__action-icon" />
                            <div className="statement-block-library__action-content">
                              <span className="statement-block-library__action-label">{entry.statement.label}</span>
                              {!hideDescriptions && entry.statement.description && (
                                <span className="statement-block-library__action-description">
                                  {entry.statement.description}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {orderedCategoryIds.map(cat => {
                  if (cat === 'template') {
                    if (filteredCombos.length === 0) return null;
                    return (
                      <div key="template" className="statement-block-library__section">
                        <div className="statement-block-library__section-title">组合母版</div>
                        <div className="statement-block-library__template-grid">
                          {filteredCombos.map(t => {
                            const sourceLabel = formatTemplateSource(t);
                            return (
                              <button
                                key={t.id}
                                type="button"
                                className="statement-block-library__template"
                                data-testid="statement-template-card"
                                data-template-id={t.id}
                                onClick={() => handleSelect('template', t.id, { templateId: t.id })}
                                title={sourceLabel ? `${t.name} · ${sourceLabel}` : t.name}
                              >
                                <IconStar width={10} height={10} className="statement-block-library__template-icon" />
                                <span className="statement-block-library__template-label">{t.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }

                  const cards = groups.get(cat);
                  if (!cards || cards.length === 0) return null;

                  return (
                    <div key={cat} className="statement-block-library__section">
                      <div className="statement-block-library__section-title">
                        {categoryLabels[cat] || cat}
                      </div>
                      <div className="statement-block-library__action-grid">
                        {cards.map(c => {
                          const IconComp = (ActionIcons as any)[c.icon] || (ActionIcons as any).default;
                          return (
                            <button key={c.id}
                              type="button"
                              data-testid="statement-block-card"
                              data-block-id={c.id}
                              data-category={c.category}
                              className={[
                                'statement-block-library__action',
                                !hideDescriptions && c.description ? 'statement-block-library__action--has-description' : '',
                                cat === 'environment' ? 'statement-block-library__action--wide' : '',
                              ].filter(Boolean).join(' ')}
                              onClick={() => handleSelect('statement', c.id, { blockId: c.id })}
                              title={!hideDescriptions && c.description ? `${c.label} - ${c.description}` : c.label}
                            >
                              <IconComp width={14} height={14} className="statement-block-library__action-icon" />
                              <div className="statement-block-library__action-content">
                                <span className="statement-block-library__action-label">{c.label}</span>
                                {!hideDescriptions && c.description && (
                                  <span className="statement-block-library__action-description">
                                    {c.description}
                                  </span>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {totalVisibleItems === 0 && !hasVisibleRecent && (
                  <div className="statement-block-library__empty">
                    {normalizedSearch ? `未找到与“${currentSearch}”匹配的语句类型或母版` : '暂无可用的语句类型'}
                  </div>
                )}
              </>
            )}

            {activeCategory !== 'all' && (
              activeCategory === 'template' ? (
                hasVisibleCombos ? (
                  <div key="template" className="statement-block-library__section">
                    <div className="statement-block-library__section-title">组合母版</div>
                    <div className="statement-block-library__template-grid">
                      {filteredCombos.map(t => {
                        const sourceLabel = formatTemplateSource(t);
                        return (
                          <button
                            key={t.id}
                            type="button"
                            className="statement-block-library__template"
                            data-testid="statement-template-card"
                            data-template-id={t.id}
                            onClick={() => handleSelect('template', t.id, { templateId: t.id })}
                            title={sourceLabel ? `${t.name} · ${sourceLabel}` : t.name}
                          >
                            <IconStar width={10} height={10} className="statement-block-library__template-icon" />
                            <span className="statement-block-library__template-label">{t.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="statement-block-library__empty">
                    {normalizedSearch ? `未找到与“${currentSearch}”匹配的组合母版` : '暂无可用的组合母版'}
                  </div>
                )
              ) : (
                (groups.get(activeCategory)?.length ?? 0) > 0 ? (
                  <div key={activeCategory} className="statement-block-library__section">
                    <div className="statement-block-library__section-title">
                      {categoryLabels[activeCategory] || activeCategory}
                    </div>
                    <div className="statement-block-library__action-grid">
                      {groups.get(activeCategory)!.map(c => {
                        const IconComp = (ActionIcons as any)[c.icon] || (ActionIcons as any).default;
                        return (
                          <button key={c.id}
                            type="button"
                            data-testid="statement-block-card"
                            data-block-id={c.id}
                            data-category={c.category}
                            className={[
                              'statement-block-library__action',
                              !hideDescriptions && c.description ? 'statement-block-library__action--has-description' : '',
                              activeCategory === 'environment' ? 'statement-block-library__action--wide' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => handleSelect('statement', c.id, { blockId: c.id })}
                            title={!hideDescriptions && c.description ? `${c.label} - ${c.description}` : c.label}
                          >
                            <IconComp width={14} height={14} className="statement-block-library__action-icon" />
                            <div className="statement-block-library__action-content">
                              <span className="statement-block-library__action-label">{c.label}</span>
                              {!hideDescriptions && c.description && (
                                <span className="statement-block-library__action-description">
                                  {c.description}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="statement-block-library__empty">
                    {normalizedSearch
                      ? `未找到与“${currentSearch}”匹配的${categoryLabels[activeCategory] || '语句'}类型`
                      : '该分类下暂无可用语句类型'}
                  </div>
                )
              )
            )}
          </>
        )}
      </div>
    </div>
  );
};

const formatTemplateSource = (template: SourcedSemanticAuthoringCombo) => {
  if (!template.source) return '';
  const scopeLabels: Record<SourcedSemanticAuthoringCombo['source']['scope'], string> = {
    project: '项目',
    user: '用户',
    community: '社区',
    builtin: '内置',
  };
  return `${scopeLabels[template.source.scope]} · ${template.source.templateName}`;
};

export default StatementBlockLibrary;
