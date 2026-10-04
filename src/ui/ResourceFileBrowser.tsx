import React, { useState, useRef, useEffect, useCallback } from 'react';
import { IconFolder, IconChevronUp, IconChevronDown } from './icons';
import { readMergedDirectory, type DirEntry } from './ResourceLibrary';
import { getTemplateResourceFileService, useTemplateResourceDirectoryRefresh } from './TemplateResourceFiles';

const STD_DIRS = ['animation', 'background', 'bgm', 'figure', 'images', 'project', 'sfx', 'template', 'vocal'];

export const ResourceFileBrowser: React.FC = () => {
  const [expanded, setExpanded] = useState(false);
  const [activeDir, setActiveDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  useEffect(() => () => { loadSequence.current += 1; }, []);

  const loadDirectory = useCallback(async (dirName: string) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setActiveDir(dirName);
    setLoadError(null);
    try {
      const result = await readMergedDirectory(dirName);
      if (sequence !== loadSequence.current) return;
      setEntries(result);
    } catch {
      if (sequence !== loadSequence.current) return;
      setEntries([]);
      setLoadError('资源目录加载失败，请重试');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useTemplateResourceDirectoryRefresh(useCallback(() => {
    if (activeDir) void loadDirectory(activeDir);
  }, [activeDir, loadDirectory]));

  const handleDragStart = (e: React.DragEvent, entry: DirEntry) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      type: 'resource',
      sourcePath: entry.path.replace(/\\/g, '/'),
      sourceKind: activeDir?.split('/')[0] || null,
      ...(entry.templateResource ? { templateResource: entry.templateResource } : {}),
    }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleToggle = () => {
    setExpanded(!expanded);
    if (!expanded && !activeDir) {
      loadDirectory('figure');
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-controls="resource-file-browser-panel"
        style={{
          width: '100%', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 12px', cursor: 'pointer',
          fontSize: 11, fontWeight: 600, opacity: 0.6,
          userSelect: 'none',
        }}
      >
        <IconFolder width={12} height={12} />
        文件资源
        <span style={{ flex: 1 }} />
        {expanded ? <IconChevronDown width={12} height={12} /> : <IconChevronUp width={12} height={12} />}
      </button>

      {expanded && (
        <div id="resource-file-browser-panel" style={{ padding: '0 8px 8px 8px' }}>
          <span id="resource-file-browser-keyboard-help" className="sr-only">
            文件资源需要使用鼠标拖动到时间轴；目录可以使用键盘打开。
          </span>
          <div role="group" aria-label="资源目录" style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6 }}>
            {STD_DIRS.map(dir => (
              <button type="button" key={dir}
                onClick={() => { void loadDirectory(dir); }}
                aria-pressed={activeDir === dir}
                style={{
                  color: 'inherit',
                  padding: '3px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                  fontSize: 10, fontWeight: activeDir === dir ? 600 : 400,
                  background: activeDir === dir ? 'var(--accent-glow)' : 'var(--bg-tertiary)',
                  border: '1px solid ' + (activeDir === dir ? 'var(--border-accent)' : 'var(--border-subtle)'),
                  transition: 'background-color 0.15s, border-color 0.15s, color 0.15s',
                }}
              >
                {dir}/
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            {activeDir?.includes('/') && (
              <button type="button" className="btn btn--sm" onClick={() => { void loadDirectory(activeDir.split('/').slice(0, -1).join('/')); }}>
                返回上级目录
              </button>
            )}
            <button type="button" className="btn btn--sm" disabled={!activeDir} onClick={() => {
              const templates = getTemplateResourceFileService();
              if (templates) templates.invalidate();
              else if (activeDir) void loadDirectory(activeDir);
            }}>刷新文件资源</button>
          </div>

          <div role="list" aria-busy={loading} aria-label={activeDir ? `${activeDir} 中的资源` : '资源'} style={{ maxHeight: 160, overflowY: 'auto', borderRadius: 'var(--radius-md)', background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
            {loading ? (
              <div role="status" aria-live="polite" style={{ padding: 12, textAlign: 'center', fontSize: 11, opacity: 0.5 }}>加载中…</div>
            ) : loadError ? (
              <div role="alert" aria-live="assertive" style={{ padding: 12, textAlign: 'center', fontSize: 11, color: 'var(--error)' }}>
                {loadError}
              </div>
            ) : entries.length === 0 ? (
              <div role="status" aria-live="polite" style={{ padding: 12, textAlign: 'center', fontSize: 11, opacity: 0.5 }}>
                {activeDir ? '目录为空' : '选择目录'}
              </div>
            ) : (
              entries.map((entry, i) => entry.isDirectory ? (
                <div role="listitem" key={entry.path || entry.name}>
                  <button type="button"
                    onClick={() => { void loadDirectory(activeDir ? `${activeDir}/${entry.name}` : entry.name); }}
                    title={entry.path}
                    style={{
                      width: '100%', border: 0, background: 'transparent', color: 'inherit', textAlign: 'left',
                      padding: '5px 10px', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontSize: 11, opacity: 0.7,
                      borderBottom: i < entries.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                    }}
                  >
                    <IconFolder width={10} height={10} style={{ opacity: 0.5 }} />
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{entry.name}</span>
                    {entry.source && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{entry.source}</span>}
                  </button>
                </div>
              ) : (
                <div key={entry.path || entry.name}
                  role="listitem"
                  tabIndex={0}
                  draggable={!entry.isDirectory}
                  onDragStart={e => handleDragStart(e, entry)}
                   aria-describedby="resource-file-browser-keyboard-help"
                   aria-label={`${entry.name}，${entry.path}，${entry.source ? `来源：${entry.source}` : '来源：项目'}，已发现，待校验，可拖动资源`}
                  className="resource-file-browser__entry"
                  style={{
                    padding: '5px 10px', cursor: 'grab',
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontSize: 11,
                    borderBottom: i < entries.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <IconFolder width={10} height={10} style={{ opacity: 0.2 }} />
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere', display: 'grid', gap: 1 }}>
                    <span>{entry.name}</span>
                    <span title={entry.path} style={{ fontSize: 9, opacity: 0.55, overflowWrap: 'anywhere' }}>{entry.path}</span>
                    <span style={{ fontSize: 9, opacity: 0.6 }}>
                      {entry.source ? `来源：${entry.source}` : '来源：项目'} · 已发现 · 待校验
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
