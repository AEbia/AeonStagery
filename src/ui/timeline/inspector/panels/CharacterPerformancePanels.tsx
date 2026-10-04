// CharacterPerformance look-at / blink editors + the "add control" buttons
// (was renderCharacterLookAtPanel / renderCharacterBlinkPanel /
// renderCharacterPerformanceControls).
import {
  InlineNumericInput,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import type { TimelineAction, TimelineScene } from '../../semanticTimelineTypes';

export interface CharacterPerformancePanelsProps {
  action: TimelineAction;
  actionType: string;
  actionParams: Record<string, any>;
  actionId: string;
  sceneData: TimelineScene;
  updateAuthoringParam: (key: string, value: any, isTransient?: boolean) => void;
  canRemoveCharacterPerformanceField: (field: 'lookAt' | 'blink') => boolean;
}

export function CharacterLookAtPanel(props: Omit<CharacterPerformancePanelsProps, never>) {
  const {
    action, actionType, actionParams, actionId, sceneData, updateAuthoringParam,
    canRemoveCharacterPerformanceField,
  } = props;

  if (action.semanticType !== 'characterPerformance') return null;
  const hasLookAt = actionParams.lookAt !== undefined || actionType === 'characterLookAt';
  if (!hasLookAt) return null;
  const lookAt = actionParams.lookAt && typeof actionParams.lookAt === 'object' && !Array.isArray(actionParams.lookAt)
    ? actionParams.lookAt as Record<string, any>
    : {};
  const point = Array.isArray(lookAt.point) && lookAt.point.length === 2
    ? lookAt.point as [number, number]
    : [0, 0] as [number, number];
  const updateLookAt = (key: string, value: any, isTransient?: boolean) => {
    updateAuthoringParam('lookAt', { ...lookAt, [key]: value }, isTransient);
  };
  const removeLookAt = () => {
    updateAuthoringParam('lookAt', undefined);
  };

  return (
    <div className="inspector-section">
      <div className="inspector-section-title" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>视线控制</span>
        {canRemoveCharacterPerformanceField('lookAt') && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            style={{ fontSize: 11, padding: '2px 6px', color: 'var(--text-muted)' }}
            onClick={removeLookAt}
            title="移除视线控制"
          >
            移除视线
          </button>
        )}
      </div>
      <div className="inspector-row">
        <label className="inspector-label" htmlFor={`action-${actionId}-look-at-target`}>注视目标</label>
        <FormSelect id={`action-${actionId}-look-at-target`} value={lookAt.target || ''} options={[
          { value: '', label: '自由点' },
          ...(sceneData.meta.characters ?? []).map((character) => ({ value: character.id, label: `${character.name} (ID: ${character.id})` })),
        ]} onChange={(value) => updateLookAt('target', value || undefined)} />
      </div>
      <div className="inspector-row">
        <span className="inspector-label">注视点</span>
        <div className="compound-input">
          <InlineNumericInput dragLabel="X" step="0.01" min="0" max="1" value={point[0]} onChange={(v, isTransient) => updateLookAt('point', [v, point[1]], isTransient)} />
          <InlineNumericInput dragLabel="Y" step="0.01" min="0" max="1" value={point[1]} onChange={(v, isTransient) => updateLookAt('point', [point[0], v], isTransient)} />
        </div>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">注视强度</span>
        <InlineNumericInput dragLabel="强度" step="0.05" min="0" max="1" value={lookAt.intensity ?? 1} onChange={(v, isTransient) => updateLookAt('intensity', v, isTransient)} />
      </div>
      <div className="inspector-row">
        <span className="inspector-label">视线时长</span>
        <InlineNumericInput
          ariaLabel="视线时长（秒）"
          dragLabel="秒"
          step="0.1"
          min="0"
          popoverMin="0"
          popoverMax="5"
          value={typeof actionParams.durationSeconds === 'number' ? actionParams.durationSeconds : 0.5}
          onChange={(value, isTransient) => updateAuthoringParam('durationSeconds', Math.max(0, value), isTransient)}
        />
      </div>
      <div className="inspector-row">
        <div />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input id={`action-${actionId}-look-at-enabled`} type="checkbox" checked={lookAt.enabled ?? true} onChange={(e) => updateLookAt('enabled', e.target.checked)} />
          <label htmlFor={`action-${actionId}-look-at-enabled`} className="inspector-label" style={{ margin: 0, textAlign: 'left' }}>启用视线</label>
        </div>
      </div>
    </div>
  );
}

export function CharacterBlinkPanel(props: CharacterPerformancePanelsProps) {
  const {
    action, actionType, actionParams, actionId, updateAuthoringParam,
    canRemoveCharacterPerformanceField,
  } = props;

  if (action.semanticType !== 'characterPerformance') return null;
  const hasBlink = actionParams.blink !== undefined || actionType === 'characterBlink';
  if (!hasBlink) return null;
  const blink = actionParams.blink && typeof actionParams.blink === 'object' && !Array.isArray(actionParams.blink)
    ? actionParams.blink as Record<string, any>
    : {};
  const updateBlink = (key: string, value: any, isTransient?: boolean) => {
    updateAuthoringParam('blink', { ...blink, [key]: value }, isTransient);
  };
  const removeBlink = () => {
    updateAuthoringParam('blink', undefined);
  };

  return (
    <div className="inspector-section">
      <div className="inspector-section-title" style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>眨眼控制</span>
        {canRemoveCharacterPerformanceField('blink') && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            style={{ fontSize: 11, padding: '2px 6px', color: 'var(--text-muted)' }}
            onClick={removeBlink}
            title="移除眨眼控制"
          >
            移除眨眼
          </button>
        )}
      </div>
      <div className="inspector-row">
        <span className="inspector-label">眨眼间隔</span>
        <InlineNumericInput dragLabel="秒" step="0.1" min="0.1" popoverMin="0.5" popoverMax="10" value={blink.interval ?? 4} onChange={(v, isTransient) => updateBlink('interval', v, isTransient)} />
      </div>
      <div className="inspector-row">
        <span className="inspector-label">随机范围</span>
        <InlineNumericInput ariaLabel="眨眼随机范围" dragLabel="±秒" step="0.1" min="0" popoverMin="0" popoverMax="5" value={blink.intervalRange ?? 0} onChange={(v, isTransient) => updateBlink('intervalRange', v, isTransient)} />
      </div>
      <div className="inspector-row">
        <div />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input id={`action-${actionId}-blink-enabled`} type="checkbox" checked={blink.enabled ?? true} onChange={(e) => updateBlink('enabled', e.target.checked)} />
          <label htmlFor={`action-${actionId}-blink-enabled`} className="inspector-label" style={{ margin: 0, textAlign: 'left' }}>启用眨眼</label>
        </div>
      </div>
    </div>
  );
}

export function CharacterPerformanceAddControls(props: Omit<CharacterPerformancePanelsProps, 'canRemoveCharacterPerformanceField'>) {
  const {
    action, actionType, actionParams, updateAuthoringParam,
  } = props;

  if (action.semanticType !== 'characterPerformance') return null;
  const isPureLookAt = actionType === 'characterLookAt'
    || (!actionParams.motion && !actionParams.expression && actionParams.lookAt !== undefined);
  const isPureBlink = actionType === 'characterBlink'
    || (!actionParams.motion && !actionParams.expression && actionParams.blink !== undefined);
  if (isPureLookAt || isPureBlink) return null;

  const hasLookAt = actionParams.lookAt !== undefined || actionType === 'characterLookAt';
  const hasBlink = actionParams.blink !== undefined || actionType === 'characterBlink';
  if (hasLookAt && hasBlink) return null;

  return (
    <div className="inspector-section" style={{ paddingTop: 8 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {!hasLookAt && (
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            style={{ flex: 1, fontSize: 12 }}
            onClick={() => updateAuthoringParam('lookAt', { point: [0, 0], intensity: 1, enabled: true })}
          >
            + 添加视线控制
          </button>
        )}
        {!hasBlink && (
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            style={{ flex: 1, fontSize: 12 }}
            onClick={() => updateAuthoringParam('blink', { enabled: true, interval: 4 })}
          >
            + 添加眨眼控制
          </button>
        )}
      </div>
    </div>
  );
}
