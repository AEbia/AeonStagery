import React, { useCallback, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconSearch, IconX, IconFolder, IconChevronUp, IconFile, IconRefresh } from './icons';
import { readMergedDirectory, DirEntry } from './ResourceLibrary';
import { useSceneAssetService } from './context/AppContext';
import type { ResourceImportKind } from '../api/types/project';
import { useModalDialog } from './hooks/useModalDialog';
import { getTemplateResourceFileService, useTemplateResourceDirectoryRefresh } from './TemplateResourceFiles';

interface AssetBrowserModalProps {
  value: string;
  onSelect: (path: string) => void;
  onClose: () => void;
  filters?: Array<{ name: string; extensions: string[] }>;
  initialDir?: string;
}

const STD_DIRS = ['animation', 'background', 'bgm', 'figure', 'images', 'project', 'sfx', 'template', 'vocal'];

export const AssetBrowserModal: React.FC<AssetBrowserModalProps> = ({ value, onSelect, onClose, filters, initialDir }) => {
  const sceneAssetService = useSceneAssetService();
  const dialogRef = useModalDialog(onClose);
  const [currentSubDir, setCurrentSubDir] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  useEffect(() => () => { loadSequence.current += 1; }, []);
  const loadMergedDir = useCallback(async (subDir: string) => {
    const sequence = ++loadSequence.current;
    setCurrentSubDir(subDir);
    setLoading(true);
    setLoadError(null);
    setSelectionError(null);
    try {
      const merged = await readMergedDirectory(subDir);
      if (sequence !== loadSequence.current) return;
      const filtered = merged.filter((entry) => {
        if (entry.isDirectory) return true;
        if (!filters || filters.length === 0) return true;
        return filters.some((filter) =>
          filter.extensions.some((ext: string) => {
            if (ext === '*' || ext === '.*') return true;
            const normalizedExt = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
            return entry.name.toLowerCase().endsWith(normalizedExt);
          }),
        );
      });
      setEntries(filtered);
    } catch {
      if (sequence !== loadSequence.current) return;
      setEntries([]);
      setLoadError('资源目录加载失败，请重试。');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [filters]);

  useTemplateResourceDirectoryRefresh(useCallback(() => {
    if (currentSubDir) void loadMergedDir(currentSubDir);
  }, [currentSubDir, loadMergedDir]));

  useEffect(() => {
    // Browse the root-relative asset path: a mount id may itself be "figure"
    // (or another category), but is not part of the directory hierarchy.
    const norm = (value || '').replace(/\\/g, '/').trim().replace(/^@mount\/[^/]+\//, '');
    const matchedDir = STD_DIRS.find((dir) => norm.includes(`/${dir}/`) || norm.startsWith(`${dir}/`) || norm === dir);

    const normalizedInitialDir = (initialDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

    if (normalizedInitialDir && STD_DIRS.some((dir) => normalizedInitialDir === dir || normalizedInitialDir.startsWith(`${dir}/`))) {
      setCurrentSubDir(normalizedInitialDir);
      void loadMergedDir(normalizedInitialDir);
    } else if (matchedDir) {
      const idx = norm.indexOf(`${matchedDir}/`);
      const relPath = idx >= 0 ? norm.slice(idx + matchedDir.length + 1) : '';
      const subDir = relPath
        ? `${matchedDir}/${relPath.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '')
        : matchedDir;
      setCurrentSubDir(subDir);
      void loadMergedDir(subDir);
    } else {
      const fallbackDir = filters?.some((filter) => filter.extensions.some((extension) => (
        ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(extension.replace(/^\./, '').toLowerCase())
      ))) ? 'images' : 'background';
      setCurrentSubDir(fallbackDir);
      void loadMergedDir(fallbackDir);
    }

  }, [filters, initialDir, loadMergedDir, value]);

  const inferImportKind = (subDir: string): ResourceImportKind => {
    const topLevel = subDir.split('/')[0] || 'project';
    if (topLevel === 'figure') return 'figure';
    if (topLevel === 'background') return 'background';
    if (topLevel === 'bgm') return 'bgm';
    if (topLevel === 'vocal') return 'vocal';
    if (topLevel === 'animation') return 'animation';
    if (topLevel === 'images') return 'images';
    if (topLevel === 'project') return 'project';
    if (topLevel === 'sfx') return 'generic';
    if (topLevel === 'template') return 'template';
    return 'generic';
  };

  const handleSelect = async (entry: DirEntry) => {
    if (entry.isDirectory) {
      const nextSubDir = currentSubDir ? `${currentSubDir}/${entry.name}` : entry.name;
      await loadMergedDir(nextSubDir);
      return;
    }

    setSelectionError(null);
    let finalPath = entry.path.replace(/\\/g, '/');
    if (!entry.templateResource && !sceneAssetService) {
      setSelectionError('资源服务不可用，未提交资源；请配置资源服务后重试，或关闭后手动修正路径。');
      return;
    }
    try {
      if (entry.templateResource) {
        const templates = getTemplateResourceFileService();
        if (!templates) throw new Error('模板资源服务不可用，请重新打开项目后重试。');
        finalPath = await templates.importFile(entry.templateResource, finalPath, inferImportKind(currentSubDir));
      } else {
        finalPath = await sceneAssetService!.importAssetPath(finalPath, inferImportKind(currentSubDir));
      }
      if (!finalPath || !finalPath.trim()) {
        throw new Error('资源服务未返回可用路径。');
      }
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : '资源导入失败，请检查资源路径后重试。');
      return;
    }
    onSelect(finalPath);
    onClose();
  };

  const handleGoUp = () => {
    if (!currentSubDir || !currentSubDir.includes('/')) return;
    const parts = currentSubDir.split('/');
    parts.pop();
    void loadMergedDir(parts.join('/'));
  };

  const filteredEntries = entries.filter((entry) => entry.name.toLowerCase().includes(search.toLowerCase()));
  const isImage = (name: string) => /\.(png|jpe?g|webp|gif|svg)$/i.test(name);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.2s ease-out',
      }}
      onPointerDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-browser-title"
        tabIndex={-1}
        style={{
          width: 'min(80vw, 1000px)',
          height: 'min(80vh, 720px)',
          minWidth: 0,
          minHeight: 0,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 24px)',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 16px 64px rgba(0,0,0,0.5)',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 20px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}>
          <div style={{ minWidth: 0 }}>
            <div id="asset-browser-title" style={{ fontWeight: 600, fontSize: 14 }}>资源浏览器</div>
            {value && (
              <div title={value} style={{ marginTop: 3, maxWidth: 'min(70vw, 720px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, opacity: 0.62 }}>
                当前引用：{value} · 路径状态待确认
              </div>
            )}
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="关闭资源浏览器"><IconX width={16} height={16} /></button>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <nav aria-label="资源分类" style={{ width: 'clamp(96px, 18vw, 180px)', minWidth: 0, flexShrink: 1, borderRight: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)', padding: '12px 8px', overflowY: 'auto' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8, paddingLeft: 8 }}>资源分类</div>
            {STD_DIRS.map((dir) => (
              <button
                type="button"
                key={dir}
                aria-current={currentSubDir === dir || currentSubDir.startsWith(`${dir}/`) ? 'page' : undefined}
                onClick={() => {
                  setSearch('');
                  void loadMergedDir(dir);
                }}
                style={{
                  width: '100%', border: 0, textAlign: 'left',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  background: currentSubDir === dir || currentSubDir.startsWith(`${dir}/`) ? 'var(--bg-hover)' : 'transparent',
                  color: currentSubDir === dir || currentSubDir.startsWith(`${dir}/`) ? 'var(--text-primary)' : 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  marginBottom: 2,
                }}
              >
                <IconFolder width={16} height={16} style={{ opacity: currentSubDir === dir || currentSubDir.startsWith(`${dir}/`) ? 1 : 0.5 }} />
                <span style={{ textTransform: 'capitalize' }}>{dir}</span>
              </button>
            ))}
          </nav>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '1 1 120px', minWidth: 0 }}>
                <button type="button" className="btn btn--icon" disabled={!currentSubDir.includes('/')} onClick={handleGoUp} title="返回上级" aria-label="返回上级目录" style={{ opacity: !currentSubDir.includes('/') ? 0.3 : 1 }}>
                  <IconChevronUp width={16} height={16} />
                </button>
                <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', opacity: 0.8, background: 'var(--bg-tertiary)', padding: '4px 12px', borderRadius: 'var(--radius-xl)' }}>
                  {currentSubDir || '/'}
                </div>
              </div>
              <div style={{ position: 'relative', width: 'min(240px, 100%)', minWidth: 0, flex: '1 1 160px' }}>
                <TextInput
                  value={search}
                  onChange={setSearch}
                  placeholder="搜索资源…"
                  icon={<IconSearch width={14} height={14} />}
                  inputStyle={{ padding: '6px 12px 6px 32px', borderRadius: 'var(--radius-full)' }}
                />
              </div>
              <button type="button" className="btn btn--icon" title="刷新文件资源" aria-label="刷新文件资源" onClick={() => {
                  const templates = getTemplateResourceFileService();
                  if (templates) templates.invalidate();
                  else void loadMergedDir(currentSubDir);
              }}><IconRefresh width={14} height={14} /></button>
            </div>

            <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16, willChange: 'transform', transform: 'translateZ(0)' }}>
              {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>加载中…</div>
              ) : loadError ? (
                <div role="alert" style={{ display: 'grid', placeItems: 'center', gap: 8, height: '100%', color: 'var(--error)', textAlign: 'center' }}>
                  <span>{loadError}</span>
                  <button type="button" className="btn btn--sm" onClick={() => { void loadMergedDir(currentSubDir); }}>重试</button>
                </div>
              ) : selectionError ? (
                <div role="alert" style={{ display: 'grid', placeItems: 'center', gap: 8, height: '100%', color: 'var(--error)', textAlign: 'center', padding: 16 }}>
                  <span>{selectionError}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>可返回上级目录或关闭后手动修正路径。</span>
                </div>
              ) : filteredEntries.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', gap: 6 }}>
                  <div>当前目录下没有匹配资源</div>
                  {!(window as any).aeonStageryAPI?.fs?.readDir && (
                    <div style={{ fontSize: 11, opacity: 0.7 }}>当前环境缺少本地目录读取 API，请手动输入路径。</div>
                  )}
                </div>
              ) : (
                <div role="list" aria-label={`${currentSubDir || '根目录'}中的资源`} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(120px, 100%), 1fr))', gap: 16 }}>
                  {filteredEntries.map((entry, i) => (
                    <div role="listitem" key={entry.path || `${entry.name}-${i}`} style={{ minWidth: 0 }}>
                      <button
                        type="button"
                        onClick={() => { void handleSelect(entry); }}
                        aria-label={`${entry.name}，${entry.path}，${entry.isDirectory ? '目录，可打开' : '已发现，待校验'}`}
                        title={entry.path}
                        style={{
                          width: '100%', height: '100%', color: 'inherit', background: 'transparent',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: 8,
                          padding: 12,
                          borderRadius: 'var(--radius-md)',
                          cursor: 'pointer',
                          transition: 'background-color 0.1s, border-color 0.1s',
                          border: '1px solid transparent',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--bg-hover)';
                          e.currentTarget.style.borderColor = 'var(--border-subtle)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.borderColor = 'transparent';
                        }}
                      >
                        <div style={{ width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                          {entry.isDirectory ? (
                            <IconFolder width={32} height={32} style={{ color: 'var(--accent-primary)' }} />
                          ) : isImage(entry.name) ? (
                            <img
                              src={`asset://localhost/${encodeURI(entry.path.replace(/\\/g, '/'))}`}
                              width={64}
                              height={64}
                              loading="lazy"
                              decoding="async"
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              alt={entry.name}
                            />
                          ) : (
                            <IconFile width={32} height={32} style={{ opacity: 0.6 }} />
                          )}
                        </div>
                        <div style={{ fontSize: 11, textAlign: 'center', wordBreak: 'break-all', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: '1.4' }}>
                          {entry.name}
                        </div>
                        <div title={entry.path} style={{ width: '100%', fontSize: 9, opacity: 0.55, textAlign: 'center', wordBreak: 'break-all', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: '1.3' }}>
                          {entry.path}
                        </div>
                        {entry.source && (
                          <div style={{ fontSize: 9, opacity: 0.5, background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 'var(--radius-sm)', marginTop: -4 }}>
                            {entry.source}
                          </div>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const TextInput = ({ value, onChange, placeholder, style, inputStyle, icon }: any) => {
  const [isFocused, setIsFocused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      style={{ display: 'flex', flex: 1, position: 'relative', ...style }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {icon && (
        <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', opacity: isFocused ? 1 : 0.5, color: isFocused ? 'var(--accent-primary)' : 'inherit', transition: 'color 0.3s, opacity 0.3s', pointerEvents: 'none', zIndex: 1 }}>
          {icon}
        </div>
      )}
      <input
        type="text"
        name="asset-search"
        autoComplete="off"
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        style={{
          width: '100%',
          padding: '10px 14px',
          borderRadius: 'var(--radius-md)',
          background: isFocused ? 'var(--bg-elevated)' : (isHovered ? 'var(--bg-secondary)' : 'var(--bg-hover)'),
          border: `1px solid ${isFocused ? 'var(--accent-primary)' : (isHovered ? 'var(--text-muted)' : 'var(--border-default)')}`,
          color: 'var(--text-primary)',
          outline: 'none',
          transition: 'background-color 0.3s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s cubic-bezier(0.16, 1, 0.3, 1), transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
          boxShadow: isFocused ? '0 0 0 3px var(--accent-glow)' : (isHovered ? '0 2px 8px rgba(0,0,0,0.1)' : 'none'),
          transform: isFocused ? 'translateY(-1px)' : 'none',
          fontSize: '13px',
          ...inputStyle,
        }}
      />
    </div>
  );
};
