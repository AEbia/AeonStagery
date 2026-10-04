import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  IconX,
  IconBell,
  IconSearch,
  IconPin,
  IconClock,
  IconCopy,
  IconCheck,
  IconExternalLink,
  IconSparkles,
} from '../icons';
import { MarkdownContent } from '../MarkdownContent';
import { useModalDialog } from '../hooks/useModalDialog';
import { useSettings } from '../SettingsStore';
import { defaultChangelogService, ChangelogService } from '../../services/announcements/ChangelogService';
import type { AnnouncementType, ChangelogItem } from '../../services/announcements/announcementTypes';
import { showToast } from '../Toast';
import './changelog.css';

export interface ChangelogDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialItemId?: string;
  changelogService?: ChangelogService;
}

type TabCategory = 'all' | 'release' | 'announcement';

export const ChangelogDialog: React.FC<ChangelogDialogProps> = ({
  isOpen,
  onClose,
  initialItemId,
  changelogService = defaultChangelogService,
}) => {
  const dialogRef = useModalDialog(onClose, isOpen);
  const { settings, setSetting } = useSettings();
  const [selectedTab, setSelectedTab] = useState<TabCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);

  const readAnnouncementIds = useMemo(
    () => settings.readAnnouncementIds || [],
    [settings.readAnnouncementIds],
  );

  const items = useMemo(() => {
    return changelogService.getItems({
      type: selectedTab === 'all' ? undefined : (selectedTab as AnnouncementType),
      searchQuery,
    });
  }, [changelogService, selectedTab, searchQuery]);

  const [selectedId, setSelectedId] = useState<string>(() => {
    if (initialItemId && changelogService.getItemById(initialItemId)) {
      return initialItemId;
    }
    const all = changelogService.getItems();
    return all[0]?.id || '';
  });

  // Ensure valid selection when filter / search changes
  useEffect(() => {
    if (items.length > 0 && !items.some((i) => i.id === selectedId)) {
      setSelectedId(items[0].id);
    }
  }, [items, selectedId]);

  // Mark currently viewed item as read
  useEffect(() => {
    if (!isOpen || !selectedId) return;
    const currentItem = changelogService.getItemById(selectedId);
    if (!currentItem) return;

    if (!readAnnouncementIds.includes(selectedId)) {
      const updated = Array.from(new Set([...readAnnouncementIds, selectedId]));
      setSetting('readAnnouncementIds', updated);
    }

    if (currentItem.type === 'release' && currentItem.version) {
      if (settings.lastReadChangelogId !== currentItem.version) {
        setSetting('lastReadChangelogId', currentItem.version);
      }
    }
  }, [isOpen, selectedId, readAnnouncementIds, settings.lastReadChangelogId, changelogService, setSetting]);

  const selectedItem: ChangelogItem | undefined = useMemo(() => {
    return items.find((i) => i.id === selectedId) || changelogService.getItemById(selectedId);
  }, [items, selectedId, changelogService]);

  const handleMarkAllRead = useCallback(() => {
    const allIds = changelogService.getAllIds();
    const latestRelease = changelogService.getLatestRelease();
    setSetting('readAnnouncementIds', allIds);
    if (latestRelease?.version) {
      setSetting('lastReadChangelogId', latestRelease.version);
    }
    showToast('已全部标记为已读', 'info');
  }, [changelogService, setSetting]);

  const handleCopyContent = useCallback(() => {
    if (!selectedItem) return;
    const fullText = `# ${selectedItem.title}\n\n日期：${selectedItem.date}\n\n${selectedItem.content}`;
    void navigator.clipboard?.writeText?.(fullText);
    setCopied(true);
    showToast('更新日志已复制到剪贴板', 'info');
    setTimeout(() => setCopied(false), 2000);
  }, [selectedItem]);

  const autoShow = settings.autoShowChangelogOnUpdate ?? true;

  if (!isOpen) return null;

  return (
    <div
      className="changelog-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="changelog-dialog-container"
        ref={dialogRef as React.RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-dialog-title"
      >
        {/* Header */}
        <header className="changelog-header">
          <div className="changelog-header-top">
            <div className="changelog-title-group">
              <div className="changelog-title-icon">
                <IconBell width={20} height={20} />
              </div>
              <div>
                <h2 id="changelog-dialog-title" className="changelog-title">
                  更新日志与公告
                </h2>
                <p className="changelog-subtitle">
                  查看 AeonStagery 的版本演进记录、新特性与官方通知
                </p>
              </div>
            </div>
            <button
              className="changelog-close-btn"
              onClick={onClose}
              title="关闭 (Esc)"
              aria-label="关闭更新日志"
            >
              <IconX width={20} height={20} />
            </button>
          </div>

          <div className="changelog-controls">
            <div className="changelog-tabs" role="tablist">
              <button
                className={`changelog-tab ${selectedTab === 'all' ? 'active' : ''}`}
                onClick={() => setSelectedTab('all')}
                role="tab"
                aria-selected={selectedTab === 'all'}
              >
                全部
              </button>
              <button
                className={`changelog-tab ${selectedTab === 'release' ? 'active' : ''}`}
                onClick={() => setSelectedTab('release')}
                role="tab"
                aria-selected={selectedTab === 'release'}
              >
                版本更新
              </button>
              <button
                className={`changelog-tab ${selectedTab === 'announcement' ? 'active' : ''}`}
                onClick={() => setSelectedTab('announcement')}
                role="tab"
                aria-selected={selectedTab === 'announcement'}
              >
                官方公告
              </button>
            </div>

            <div className="changelog-search-box">
              <IconSearch width={14} height={14} className="changelog-search-icon" />
              <input
                type="text"
                className="changelog-search-input"
                placeholder="搜索版本、特性或关键词..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="搜索更新日志"
              />
            </div>
          </div>
        </header>

        {/* Body (Split View) */}
        <div className="changelog-body">
          {/* Left Sidebar List */}
          <nav className="changelog-sidebar" aria-label="更新日志列表">
            {items.length === 0 ? (
              <div className="changelog-empty-state">
                <IconSearch width={32} height={32} className="changelog-empty-icon" />
                <p>未找到符合条件的更新记录</p>
              </div>
            ) : (
              items.map((item) => {
                const isSelected = item.id === selectedId;
                const isUnread = changelogService.isItemUnread(
                  item,
                  settings.lastReadChangelogId,
                  readAnnouncementIds,
                );

                return (
                  <div
                    key={item.id}
                    className={`changelog-item-card ${isSelected ? 'active' : ''}`}
                    onClick={() => setSelectedId(item.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        setSelectedId(item.id);
                      }
                    }}
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <div className="changelog-card-header">
                      <div className="changelog-badge-row">
                        {item.pinned && (
                          <span className="changelog-badge changelog-badge--warning" title="置顶公告">
                            <IconPin width={10} height={10} style={{ display: 'inline', marginRight: 2 }} />
                            置顶
                          </span>
                        )}
                        {item.version && (
                          <span className="changelog-badge changelog-badge--primary">
                            {item.version}
                          </span>
                        )}
                        {item.tags?.map((t, idx) => (
                          <span
                            key={idx}
                            className={`changelog-badge changelog-badge--${t.color || 'info'}`}
                          >
                            {t.label}
                          </span>
                        ))}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="changelog-card-date">{item.date}</span>
                        {isUnread && <span className="changelog-unread-dot" title="未读" />}
                      </div>
                    </div>

                    <h4 className="changelog-card-title">{item.title}</h4>
                    {item.summary && <p className="changelog-card-summary">{item.summary}</p>}
                  </div>
                );
              })
            )}
          </nav>

          {/* Right Content View */}
          <main className="changelog-content-area" tabIndex={-1}>
            {selectedItem ? (
              <>
                <div className="changelog-content-header">
                  <div className="changelog-content-headline">
                    <h3 className="changelog-content-title">{selectedItem.title}</h3>
                    <div className="changelog-content-actions">
                      <button
                        className="changelog-action-btn"
                        onClick={handleCopyContent}
                        title="复制更新日志 Markdown"
                      >
                        {copied ? <IconCheck width={14} height={14} /> : <IconCopy width={14} height={14} />}
                        {copied ? '已复制' : '复制内容'}
                      </button>
                      {selectedItem.externalUrl && (
                        <a
                          className="changelog-action-btn"
                          href={selectedItem.externalUrl}
                          target="_blank"
                          rel="noreferrer"
                          title="在浏览器中查看"
                        >
                          <IconExternalLink width={14} height={14} />
                          网页查看
                        </a>
                      )}
                    </div>
                  </div>

                  <div className="changelog-content-meta">
                    <span className="changelog-content-date">
                      <IconClock width={13} height={13} />
                      发布日期：{selectedItem.date}
                    </span>
                    {selectedItem.type === 'release' && (
                      <span className="changelog-badge changelog-badge--success">版本发布</span>
                    )}
                    {selectedItem.type === 'announcement' && (
                      <span className="changelog-badge changelog-badge--warning">官方公告</span>
                    )}
                  </div>
                </div>

                <div className="changelog-markdown-wrapper">
                  <MarkdownContent text={selectedItem.content} />
                </div>
              </>
            ) : (
              <div className="changelog-empty-state">
                <IconSparkles width={40} height={40} className="changelog-empty-icon" />
                <p>请选择左侧列表查看详细内容</p>
              </div>
            )}
          </main>
        </div>

        {/* Footer */}
        <footer className="changelog-footer">
          <label className="changelog-auto-prompt-label">
            <input
              type="checkbox"
              className="changelog-auto-prompt-checkbox"
              checked={autoShow}
              onChange={(e) => setSetting('autoShowChangelogOnUpdate', e.target.checked)}
            />
            新版本启动时自动弹出更新日志
          </label>

          <div className="changelog-footer-actions">
            <button className="btn btn--secondary btn--sm" onClick={handleMarkAllRead}>
              全部标为已读
            </button>
            <button className="btn btn--primary btn--sm" onClick={onClose}>
              我知道了
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};
