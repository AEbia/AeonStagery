import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WebGalScssImportInspection } from '../api/types/template-package-import';
import { uniquePackageName } from '../services/import/webgal/WebGalScssPackageNaming';
import { IconInfo, IconTimelineDialogue, IconWarning, IconX } from './icons';
import { useModalDialog } from './hooks/useModalDialog';

export interface WebGalScssImportChoice {
  /** `new` adds another package; `overwrite` replaces an installed one. */
  mode: 'new' | 'overwrite';
  /** Display name for the package. */
  packageName: string;
  /** Package id to replace, when `mode` is `overwrite`. */
  replacePackageId?: string;
}

export interface WebGalScssImportDialogProps {
  readonly inspection: WebGalScssImportInspection;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (choice: WebGalScssImportChoice) => void;
}

/** Why a candidate import was flagged as a duplicate. */
function describeConflict(conflict: WebGalScssImportInspection['conflicts'][number]): string {
  if (conflict.contentMatch) return '样式表内容与已导入的一致';
  if (conflict.paramsMatch) return '翻译出的样式参数与已导入的一致';
  return '来源目录与已导入的一致，样式已修改';
}

export function WebGalScssImportDialog({
  inspection,
  busy = false,
  onCancel,
  onConfirm,
}: WebGalScssImportDialogProps) {
  const dialogRef = useModalDialog(onCancel);
  const [name, setName] = useState('');
  const [replaceId, setReplaceId] = useState(
    inspection.conflicts.find((item) => item.replaceable)?.packageId ?? '',
  );

  const trimmed = name.trim();
  const effectiveName = trimmed || inspection.packageName;
  const taken = inspection.takenPackageNames.includes(effectiveName);
  // What the package will actually be called once collisions are resolved.
  const resolvedName = useMemo(
    () => uniquePackageName(effectiveName, inspection.takenPackageNames),
    [effectiveName, inspection.takenPackageNames],
  );

  const conflicts = inspection.conflicts;
  // A package publishing several styles cannot be rebuilt from one stylesheet,
  // so it is reported but never offered as a replace target.
  const replaceableConflicts = conflicts.filter((item) => item.replaceable);
  const selectedConflict = replaceableConflicts.find((item) => item.packageId === replaceId)
    ?? replaceableConflicts[0]
    ?? null;
  const sourceDirectory = inspection.templateRoot.split(/[\\/]/).filter(Boolean).pop() ?? inspection.templateRoot;

  const confirm = (mode: WebGalScssImportChoice['mode']) => {
    onConfirm({
      mode,
      packageName: effectiveName,
      ...(mode === 'overwrite' && selectedConflict ? { replacePackageId: selectedConflict.packageId } : {}),
    });
  };

  return createPortal(
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="webgal-scss-import-title"
        tabIndex={-1}
        style={{ width: 480, maxWidth: '92vw' }}
      >
        <div
          id="webgal-scss-import-title"
          className="modal__header"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 18 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <IconTimelineDialogue width={18} height={18} style={{ color: 'var(--color-dialogue, #10b981)', flexShrink: 0 }} />
            <span>导入 WebGAL 字幕样式</span>
          </div>
          <button
            type="button"
            className="btn btn--icon"
            onClick={onCancel}
            disabled={busy}
            title="关闭"
            aria-label="关闭"
          >
            <IconX width={14} height={14} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* 来源信息卡片 */}
          <div
            style={{
              display: 'grid',
              gap: 8,
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-subtle)',
              fontSize: 12,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>来源模板</span>
              <span
                style={{
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={inspection.templateName}
              >
                {inspection.templateName}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>读取文件</span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-surface)',
                  padding: '2px 6px',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-subtle)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={`Stage/TextBox/${inspection.sourceName}`}
              >
                Stage/TextBox/{inspection.sourceName}
              </span>
            </div>
            {sourceDirectory !== inspection.templateName && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>模板目录</span>
                <span
                  style={{
                    color: 'var(--text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 260,
                  }}
                  title={inspection.templateRoot}
                >
                  {sourceDirectory}
                </span>
              </div>
            )}
          </div>

          {/* 样式名称输入 */}
          <div className="form-group">
            <label htmlFor="webgal-scss-package-name" className="form-label">样式名称</label>
            <input
              id="webgal-scss-package-name"
              className="form-input"
              value={name}
              placeholder={inspection.packageName}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              style={{
                borderColor: taken ? 'var(--warning, #f59e0b)' : undefined,
              }}
            />
            <div
              style={{
                fontSize: 11.5,
                marginTop: 2,
                color: taken ? 'var(--warning, #f59e0b)' : 'var(--text-muted)',
              }}
            >
              {taken
                ? `“${effectiveName}” 已被占用，将保存为 “${resolvedName}”`
                : `留空时自动命名为 “${inspection.packageName}”`}
            </div>
          </div>

          {/* 重复导入冲突提示 */}
          {conflicts.length > 0 && (
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--warning-surface, rgba(245, 158, 11, 0.08))',
                border: '1px solid color-mix(in srgb, var(--warning, #f59e0b) 25%, var(--border-subtle))',
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontWeight: 600,
                  color: 'var(--warning, #f59e0b)',
                  marginBottom: 6,
                  fontSize: 12.5,
                }}
              >
                <IconWarning width={15} height={15} style={{ flexShrink: 0 }} />
                <span>发现 {conflicts.length} 个已导入样式匹配项</span>
              </div>
              {conflicts.length > 1 ? (
                replaceableConflicts.length > 0 ? (
                  <select
                    className="form-input"
                    value={selectedConflict?.packageId ?? ''}
                    onChange={(event) => setReplaceId(event.target.value)}
                    disabled={busy}
                    style={{ width: '100%', marginBottom: 6, fontSize: 12 }}
                  >
                    {replaceableConflicts.map((conflict) => (
                      <option key={conflict.packageId} value={conflict.packageId}>
                        {conflict.packageName} — {describeConflict(conflict)}
                      </option>
                    ))}
                  </select>
                ) : null
              ) : (
                <div style={{ color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{conflicts[0].packageName}</span>
                  {'：'}
                  {describeConflict(conflicts[0])}
                  {conflicts[0].importedAt ? `（导入于 ${conflicts[0].importedAt.slice(0, 10)}）` : ''}
                </div>
              )}
              <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {replaceableConflicts.length > 0
                  ? '选择「覆盖已有」将保留原包名与样式 ID，并同步更新当前场景中引用该样式的对白；对白更新可撤销。'
                  : '该模板包含多个对话框样式，覆盖操作会导致其他样式与资源丢失，建议选择「另存为新的一份」。'}
              </div>
            </div>
          )}

          {/* 无来源记录的历史模板提示 */}
          {inspection.unverifiableCount > 0 && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-subtle)',
                fontSize: 11.5,
                color: 'var(--text-muted)',
                lineHeight: 1.5,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
              }}
            >
              <IconInfo width={14} height={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--text-muted)' }} />
              <span>
                另有 {inspection.unverifiableCount} 个较早导入的模板没有来源记录，本次无法自动比对；如为同一模板，建议先删除后再重新导入。
              </span>
            </div>
          )}

          {/* 转换说明（折叠展开） */}
          {inspection.notes.length > 0 && (
            <details
              style={{
                fontSize: 12,
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 12px',
              }}
            >
              <summary
                style={{
                  cursor: 'pointer',
                  fontWeight: 500,
                  color: 'var(--text-secondary)',
                  userSelect: 'none',
                }}
              >
                转换说明（{inspection.notes.length} 条）
              </summary>
              <ul
                style={{
                  margin: '8px 0 0',
                  paddingLeft: 16,
                  lineHeight: 1.7,
                  maxHeight: 140,
                  overflowY: 'auto',
                  color: 'var(--text-muted)',
                  fontSize: 11.5,
                }}
              >
                {inspection.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="modal__footer" style={{ marginTop: 20, paddingTop: 16 }}>
          <button className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          {conflicts.length > 0 ? (
            <>
              <button className="btn" onClick={() => confirm('new')} disabled={busy}>
                另存为新的一份
              </button>
              {replaceableConflicts.length > 0 && (
                <button className="btn btn--primary" onClick={() => confirm('overwrite')} disabled={busy}>
                  {busy ? '正在导入…' : '覆盖已有'}
                </button>
              )}
            </>
          ) : (
            <button className="btn btn--primary" onClick={() => confirm('new')} disabled={busy}>
              {busy ? '正在导入…' : '导入'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
