import { useEffect, useRef, useState } from 'react';

export interface WebGalRegenerateDialogProps {
  open: boolean;
  scriptName: string;
  defaultSpeed: number;
  onCancel: () => void;
  onConfirm: (speed: number) => void;
}

const SPEED_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1.125, label: '慢速' },
  { value: 1.5, label: '标准' },
  { value: 2.25, label: '快速' },
];

/**
 * Confirms regenerating the scene owned by the stored WebGAL import receipt.
 * Regeneration replaces the current scene file and reloads it, so the dialog
 * warns before the user commits.
 */
export function WebGalRegenerateDialog({
  open,
  scriptName,
  defaultSpeed,
  onCancel,
  onConfirm,
}: WebGalRegenerateDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [speed, setSpeed] = useState(defaultSpeed);

  useEffect(() => {
    if (open) setSpeed(defaultSpeed);
  }, [open, defaultSpeed]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="webgal-regenerate-dialog-title"
        tabIndex={-1}
        style={{ maxWidth: 460 }}
      >
        <div className="modal__header">
          <span id="webgal-regenerate-dialog-title">重新生成 WebGAL 场景</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn--icon" onClick={onCancel} aria-label="关闭" title="关闭" style={{ fontSize: 16 }}>×</button>
        </div>

        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            剧本：{scriptName}
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              阅读速度（决定没有配音的台词停留多久；有配音的台词以音频实际时长为准）
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {SPEED_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className="btn"
                  onClick={() => setSpeed(option.value)}
                  style={{
                    flex: 1,
                    borderColor: speed === option.value ? 'var(--accent-primary)' : undefined,
                    background: speed === option.value ? 'var(--bg-secondary)' : undefined,
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--warning)', lineHeight: 1.6 }}>
            重新生成会用保存的原始剧本替换当前场景内容（包括你已做的修改），生成后立即生效。确定要重新生成吗？
          </div>
        </div>

        <div className="modal__footer">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn btn--primary" onClick={() => onConfirm(speed)}>重新生成</button>
        </div>
      </div>
    </div>
  );
}
