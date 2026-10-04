import { memo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalDialog } from '../hooks/useModalDialog';
import type { CustomMotionDensity } from '../../engine/live2d/customMotionConversion';
import { DiamondIcon } from './CustomMotionEditor';

export interface CustomMotionConversionDialogState {
  /** First conversion or explicit regeneration from the recorded source. */
  mode: 'convert' | 'regenerate';
  /** Character target id of the source characterPerformance. */
  targetId: string;
  /** Source motion key being converted. */
  motionKey: string;
  /** Scene-relative source motion duration (seconds). */
  durationSeconds: number;
}

export interface CustomMotionConversionDialogProps {
  open: CustomMotionConversionDialogState | null;
  /** Estimated keyframe count for the given density (motion-local). */
  estimateKeyframes: (density: CustomMotionDensity) => number;
  /** Conversion in-flight; disables the confirm button. */
  busy?: boolean;
  onConfirm: (density: CustomMotionDensity) => void;
  onCancel: () => void;
}

const DENSITIES: { id: CustomMotionDensity; name: string; desc: string }[] = [
  { id: 'sparse', name: '稀疏', desc: '最少关键帧，曲线平滑' },
  { id: 'standard', name: '标准', desc: '平衡精度与可编辑性（推荐）' },
  { id: 'fine', name: '精细', desc: '保留更多动作细节' },
  { id: 'perFrame', name: '逐帧', desc: '逐帧生成关键帧' },
];

export const CustomMotionConversionDialog = memo(({
  open,
  estimateKeyframes,
  busy = false,
  onConfirm,
  onCancel,
}: CustomMotionConversionDialogProps) => {
  const [density, setDensity] = useState<CustomMotionDensity>('standard');
  const dialogRef = useModalDialog(onCancel, !!open);

  if (!open) return null;
  const isRegeneration = open.mode === 'regenerate';

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 10000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-motion-conversion-title"
        style={{
          background: 'var(--bg-secondary)',
          padding: 20,
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          width: 'min(520px, calc(100vw - 32px))',
          maxHeight: 'min(720px, calc(100vh - 48px))',
          border: '1px solid var(--border-default)',
          boxShadow: '0 18px 72px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: 'var(--accent-primary)', display: 'flex' }}><DiamondIcon size={16} /></span>
          <div>
            <div id="custom-motion-conversion-title" style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>
              {isRegeneration ? '从源动作重新生成' : '转为自定义动作'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
              {open.motionKey} · {open.durationSeconds.toFixed(2)}s
            </div>
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '6px 14px',
          padding: '8px 10px',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-tertiary)',
          fontSize: 10.5,
        }}>
          <div>
            <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>角色</span>
            <strong style={{ color: 'var(--text-primary)', fontSize: 11, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{open.targetId}</strong>
          </div>
          <div>
            <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>源动作时长</span>
            <strong style={{ color: 'var(--text-primary)', fontSize: 11, display: 'block' }}>{open.durationSeconds.toFixed(2)}s</strong>
          </div>
        </div>

        {isRegeneration && (
          <div
            role="alert"
            style={{
              padding: '8px 10px',
              border: '1px solid color-mix(in srgb, var(--warning) 32%, transparent)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--warning-surface)',
              color: 'var(--text-secondary)',
              fontSize: 10.5,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ display: 'block', color: 'var(--warning)', fontSize: 11.5 }}>
              当前全部关键帧和手工调整都会被替换。
            </strong>
          </div>
        )}

        <div role="radiogroup" aria-label="关键帧密度" style={{ display: 'grid', gap: 7 }}>
          {DENSITIES.map((item) => {
            const selected = density === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => { if (!busy) setDensity(item.id); }}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '18px minmax(0, 1fr) auto',
                  gap: 10,
                  alignItems: 'center',
                  padding: '10px 12px',
                  border: `1px solid ${selected ? 'var(--border-accent)' : 'var(--border-default)'}`,
                  borderRadius: 'var(--radius-md)',
                  background: selected ? 'var(--accent-glow)' : 'var(--bg-surface)',
                  color: 'var(--text-primary)',
                  cursor: busy ? 'default' : 'pointer',
                  textAlign: 'left',
                  opacity: busy ? 0.75 : 1,
                }}
              >
                <span style={{
                  width: 14, height: 14, borderRadius: '50%',
                  border: `2px solid ${selected ? 'var(--accent-primary)' : 'var(--text-muted)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {selected && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-primary)' }} />}
                </span>
                <span>
                  <span style={{ display: 'block', fontSize: 12.5, fontWeight: 800 }}>{item.name}</span>
                  <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>{item.desc}</span>
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                  约 {estimateKeyframes(item.id)} 帧
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={{
              padding: '6px 16px',
              background: 'var(--bg-hover)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onConfirm(density)}
            style={{
              padding: '6px 18px',
              background: 'var(--accent-primary)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              cursor: busy ? 'default' : 'pointer',
              fontWeight: 600,
            }}
          >
            {busy ? (isRegeneration ? '重新生成中…' : '转换中…') : (isRegeneration ? '重新生成' : '开始转换')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
});

CustomMotionConversionDialog.displayName = 'CustomMotionConversionDialog';
