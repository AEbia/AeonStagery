import React, { useState } from 'react';
import { IconFolder, IconX } from './icons';
import { AssetBrowserModal } from './AssetBrowserModal';
import { useSceneAssetService } from './context/AppContext';
import type { ResourceImportKind } from '../api/types/project';

interface InlineFilePickerProps {
  value: string;
  onChange: (path: string) => void;
  filters?: Array<{ name: string; extensions: string[] }>;
  placeholder?: string;
  importKindOverride?: ResourceImportKind;
  inputId?: string;
  initialDirOverride?: string;
  presentation?: 'input' | 'asset';
}

export const InlineFilePicker: React.FC<InlineFilePickerProps> = ({
  value,
  onChange,
  filters,
  placeholder,
  importKindOverride,
  inputId,
  initialDirOverride,
  presentation = 'input',
}) => {
  const [showModal, setShowModal] = useState(false);
  const [localValue, setLocalValue] = useState(value || '');
  const [pathError, setPathError] = useState<string | null>(null);
  const sceneAssetService = useSceneAssetService();

  React.useEffect(() => {
    const nextValue = value || '';
    setLocalValue(nextValue);
    setPathError(null);
  }, [value]);

  const inferImportKind = (): ResourceImportKind => {
    if (importKindOverride) return importKindOverride;
    const extensions = (filters || []).flatMap((filter) => filter.extensions || []);
    if (extensions.includes('wmdl')) return 'figure';
    if (extensions.some((ext) => ['mp3', 'wav', 'ogg'].includes(ext))) return 'bgm';
    if (extensions.some((ext) => ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext))) return 'images';
    if (extensions.includes('html')) return 'animation';
    return 'generic';
  };

  const inferInitialDir = (): string => {
    if (initialDirOverride) return initialDirOverride;
    const kind = inferImportKind();
    if (kind === 'figure') return 'figure';
    if (kind === 'background') return 'background';
    if (kind === 'bgm') return 'bgm';
    if (kind === 'vocal') return 'vocal';
    if (kind === 'animation') return 'animation';
    if (kind === 'template') return 'template';
    if (kind === 'images') return 'images';
    return 'project';
  };

  const commitValue = async () => {
    const nextValue = (localValue || '').trim();
    if (!nextValue) {
      setPathError(null);
      onChange('');
      return;
    }

    if (!sceneAssetService) {
      setPathError('资源服务不可用；路径仅保留为待确认草稿。');
      return;
    }

    try {
      const normalized = await sceneAssetService.importAssetPath(nextValue, inferImportKind());
      if (!normalized || !normalized.trim()) {
        throw new Error('资源服务未返回可用路径。');
      }
      setLocalValue(normalized);
      setPathError(null);
      onChange(normalized);
    } catch (error) {
      setPathError(error instanceof Error ? `资源导入失败：${error.message}` : '资源导入失败；路径仅保留为待确认草稿。');
    }
  };

  const renderPathError = () => (
    pathError ? <div role="alert" style={{ marginTop: 2, fontSize: 9, color: 'var(--warning)' }}>{pathError}</div> : null
  );

  return (
    <div className="inline-file-picker" style={{ flex: 1, minWidth: 0, width: '100%' }}>
      {presentation === 'asset' && (
        <div className="inspector-asset-picker">
          <div className="inspector-asset-picker__selection">
            <button
              id={inputId}
              type="button"
              className="inspector-asset-picker__browse"
              title={localValue || '打开资源浏览器'}
              onClick={() => setShowModal(true)}
            >
              <IconFolder width={16} height={16} />
              <span className="inspector-asset-picker__name">{localValue.split(/[\\/]/).pop() || placeholder || '选择文件...'}</span>
              <span className="inspector-asset-picker__action">选择</span>
            </button>
            {localValue && <button type="button" className="btn btn--icon" aria-label="清除资源" onClick={() => { setLocalValue(''); setPathError(null); onChange(''); }}><IconX width={14} height={14} /></button>}
          </div>
          {localValue && <div className="inspector-asset-picker__path" title={localValue}>{localValue}</div>}
        </div>
      )}
      {presentation === 'input' && renderPathInput()}
      {renderPathError()}

      {showModal && (
        <AssetBrowserModal
          value={localValue}
          onSelect={(nextValue) => {
            setLocalValue(nextValue);
            setPathError(null);
            onChange(nextValue);
          }}
          onClose={() => setShowModal(false)}
          filters={filters}
          initialDir={inferInitialDir()}
        />
      )}
    </div>
  );

  function renderPathInput() {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0, width: '100%' }}>
        <input
          id={inputId}
          type="text"
          value={localValue}
          onChange={e => {
            setLocalValue(e.target.value);
            setPathError(null);
          }}
          onBlur={() => { void commitValue(); }}
          placeholder={placeholder || '选择文件...'}
          style={{ flex: 1, minWidth: 0, width: 0, padding: '6px 8px', borderRadius: 'var(--radius-md)', background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', fontSize: 12 }}
        />
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => setShowModal(true)}
          title="打开资源浏览器"
          aria-label="打开资源浏览器"
          style={{ width: 28, height: 28, flexShrink: 0, border: '1px solid var(--border-default)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}
        >
          <IconFolder width={14} height={14} />
        </button>
      </div>
    );
  }
};
