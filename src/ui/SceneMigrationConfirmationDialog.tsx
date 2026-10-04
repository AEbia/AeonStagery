import { createPortal } from 'react-dom';
import type { SceneMigrationConfirmationRequest } from '../services/semantic-scene/SceneMigrationExperience';
import { IconX } from './icons';
import { useModalDialog } from './hooks/useModalDialog';

export interface SceneMigrationConfirmationDialogProps {
  readonly request: SceneMigrationConfirmationRequest;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function SceneMigrationConfirmationDialog({
  request,
  onConfirm,
  onCancel,
}: SceneMigrationConfirmationDialogProps) {
  const dialogRef = useModalDialog(onCancel);
  const { scenePath, backupPath, warnings } = request;

  return createPortal(
    <div
      ref={dialogRef}
      className="scene-migration-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scene-migration-dialog-title"
      aria-describedby="scene-migration-dialog-warning"
    >
      <div className="scene-migration-dialog__surface">
        <div className="scene-migration-dialog__header">
          <div>
            <div id="scene-migration-dialog-title" className="scene-migration-dialog__title">
              升级场景文件
            </div>
            <div className="scene-migration-dialog__subtitle">
              检测到旧版本场景文件，需要升级后打开
            </div>
          </div>
          <button
            className="btn btn--icon scene-migration-dialog__close"
            onClick={onCancel}
            title="取消升级"
            aria-label="取消升级"
          >
            <IconX width={14} height={14} />
          </button>
        </div>

        <div className="scene-migration-dialog__body">
          <div id="scene-migration-dialog-warning" className="scene-migration-dialog__warning">
            该场景由较早版本创建，需要转换为当前格式才能打开。系统已自动为原文件创建备份，确认后将升级并打开场景。
          </div>

          <div className="scene-migration-dialog__meta">
            <div className="scene-migration-dialog__meta-row">
              <span className="scene-migration-dialog__meta-label">场景路径:</span>
              <span className="scene-migration-dialog__meta-value" title={scenePath}>
                {scenePath}
              </span>
            </div>
            <div className="scene-migration-dialog__meta-row">
              <span className="scene-migration-dialog__meta-label">备份路径:</span>
              <span className="scene-migration-dialog__meta-value" title={backupPath}>
                {backupPath}
              </span>
            </div>
          </div>

          {warnings.length > 0 && (
            <div className="scene-migration-dialog__warnings">
              <div className="scene-migration-dialog__warnings-title">
                注意事项 ({warnings.length} 条):
              </div>
              <ul className="scene-migration-dialog__warnings-list">
                {warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="scene-migration-dialog__footer">
          <button
            className="btn btn--secondary scene-migration-dialog__cancel"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="btn btn--primary scene-migration-dialog__confirm"
            onClick={onConfirm}
          >
            确认升级
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
