import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WebGalScssImportInspection } from '../api/types/template-package-import';
import { uniquePackageName } from '../services/import/webgal/WebGalScssPackageNaming';
import { IconX } from './icons';
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
  return '翻译出的样式参数与已导入的一致';
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
        style={{ width: 560, maxWidth: '92vw' }}
      >
        <div
          id="webgal-scss-import-title"
          className="modal__header"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <span>导入 WebGAL 字幕样式</span>
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

        <div style={{ padding: '4px 16px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, wordBreak: 'break-all' }}>
            来源模板：<strong style={{ color: 'var(--text-primary)' }}>{inspection.templateName}</strong>
            <br />
            读取文件：Stage/TextBox/{inspection.sourceName}
            <br />
            模板目录：{sourceDirectory}
          </div>

          <div className="form-group">
            <div className="form-label">样式名称</div>
            <input
              className="form-input"
              value={name}
              placeholder={inspection.packageName}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              {taken
                ? `“${effectiveName}” 已被占用，将保存为 “${resolvedName}”`
                : `留空 = 自动命名为 “${inspection.packageName}”`}
            </div>
          </div>

          {conflicts.length > 0 && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-tertiary)',
                borderLeft: '2px solid var(--accent-warning, #d9a441)',
                fontSize: 12,
                lineHeight: 1.7,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                这份字幕看起来已经导入过（{conflicts.length} 处匹配）
              </div>
              {conflicts.length > 1 ? (
                replaceableConflicts.length > 0 ? (
                  <select
                    className="form-input"
                    value={selectedConflict?.packageId ?? ''}
                    onChange={(event) => setReplaceId(event.target.value)}
                    disabled={busy}
                    style={{ marginBottom: 6 }}
                  >
                    {replaceableConflicts.map((conflict) => (
                      <option key={conflict.packageId} value={conflict.packageId}>
                        {conflict.packageName} — {describeConflict(conflict)}
                      </option>
                    ))}
                  </select>
                ) : null
              ) : (
                <div>
                  <span style={{ color: 'var(--text-secondary)' }}>{conflicts[0].packageName}：</span>
                  {describeConflict(conflicts[0])}
                  {conflicts[0].importedAt ? `（导入于 ${conflicts[0].importedAt.slice(0, 10)}）` : ''}
                </div>
              )}
              {replaceableConflicts.length > 0 ? (
                <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>
                  选择「覆盖已有」会保留原包名与样式 ID，场景里已经引用该样式的台词不受影响。
                </div>
              ) : (
                <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>
                  该模板包含多个对话框样式，覆盖会删除本次无法还原的样式与资源，因此只能「另存为新的一份」。
                </div>
              )}
            </div>
          )}

          {inspection.unverifiableCount > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              另有 {inspection.unverifiableCount} 个较早导入的模板没有来源记录，本次无法自动比对；
              如果它们就是这一份，建议先删除后再导入。
            </div>
          )}

          {inspection.notes.length > 0 && (
            <details style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              <summary style={{ cursor: 'pointer' }}>转换说明（{inspection.notes.length} 条）</summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.8, maxHeight: 180, overflow: 'auto' }}>
                {inspection.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="modal__footer">
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
