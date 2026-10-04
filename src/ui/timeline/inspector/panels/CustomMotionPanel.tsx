// "Custom motion" summary card (was renderCustomMotionPanel).
import type { CharacterMotionOutput } from '../../../../api/types/semantic-scene';
import { DiamondIcon } from '../../CustomMotionEditor';

export interface CustomMotionPanelProps {
  customMotionValue: Extract<CharacterMotionOutput, { kind: 'custom' }> | null;
  actionId: string;
  expandedCustomMotionActionId: string | null;
  editorStore: { setCustomMotionEditorActionId: (id: string | null) => void };
  openConversionDialog: () => void;
}

export function CustomMotionPanel(props: CustomMotionPanelProps) {
  const { customMotionValue, actionId, expandedCustomMotionActionId, editorStore, openConversionDialog } = props;

  if (!customMotionValue) return null;
  const { derivedFrom, tracks } = customMotionValue;
  const totalKeyframes = tracks.reduce((sum, track) => sum + track.keyframes.length, 0);
  const editorOpen = expandedCustomMotionActionId === actionId;
  return (
    <div className="inspector-section" data-testid="custom-motion-panel">
      <div className="inspector-section-title">自定义动作</div>
      <div style={{
        border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)',
        padding: '10px 10px 4px', marginBottom: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <span style={{ color: 'var(--accent-primary)', display: 'flex' }}><DiamondIcon size={12} /></span>
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>自定义动作</span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 'var(--radius-full)',
            background: 'var(--accent-glow)', border: '1px solid var(--border-accent)', color: 'var(--accent-primary)',
            fontSize: 9.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>可编辑关键帧</span>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          padding: '6px 8px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-tertiary)', marginBottom: 8,
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={derivedFrom.key}>
            {derivedFrom.key}
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>源动作</span>
        </div>
        <div className="inspector-row" style={{ marginBottom: 8 }}>
          <label className="inspector-label">轨道统计</label>
          <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{tracks.length} 条 · {totalKeyframes} 帧</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            title="在下方轨道区展开/收起关键帧编辑器"
            onClick={() => editorStore.setCustomMotionEditorActionId(editorOpen ? null : actionId)}
          >
            {editorOpen ? '收起关键帧编辑器' : '编辑关键帧'}
          </button>
          <button type="button" className="btn btn--sm" onClick={openConversionDialog} title="重选密度重新转换">
            重新转换…
          </button>
        </div>
        <div className="inspector-hint" style={{ fontSize: 10.5, lineHeight: 1.5, margin: '2px 0 8px', color: 'var(--text-muted)' }}>
          关键帧编辑器会在下方轨道区随时间轴展开；修改实时走 codec 严格校验：首帧锁定、时间不冲突、时长不小于淡入。
        </div>
      </div>
    </div>
  );
}
