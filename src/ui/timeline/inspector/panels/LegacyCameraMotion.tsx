// Legacy (pre-semantic) cameraMotion + cameraPath editor section, including
// the push/pull/zoom compound row (was the inline cameraMotion JSX block and
// renderLegacyCameraZoom).
import {
  InlineNumericInput,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import type { ActionInspectorProps } from '../../ActionInspector';
import type { TimelineAction, TimelineScene } from '../../semanticTimelineTypes';
import {
  readCameraMotionZoom,
  serializeCameraMotionZoom,
  type CameraMotionZoomKind,
} from '../cameraMotionZoom';

export interface LegacyCameraMotionProps {
  action: TimelineAction;
  actionType: string;
  actionId: string;
  actionParams: Record<string, any>;
  sceneData: TimelineScene;
  updateParam: ActionInspectorProps['updateParam'];
}

export function LegacyCameraMotionSection(props: LegacyCameraMotionProps) {
  const { action, actionType, actionId, actionParams, sceneData, updateParam } = props;
  const currentMove = String(actionParams.move || 'push');
  const moveOptions = [
    { value: 'push', label: '推' },
    { value: 'pull', label: '拉' },
    { value: 'pan', label: '摇' },
    { value: 'tilt', label: '直摇' },
    { value: 'zoom', label: '变焦' },
    ...(currentMove === 'dolly' ? [{ value: 'dolly', label: '希区柯克' }] : []),
    { value: 'rotate', label: '旋转' },
    { value: 'shake', label: '震动' },
    { value: 'follow', label: '跟随' },
  ];

  const renderLegacyCameraZoom = () => {
  const move = String(actionParams.move || 'push');
  if (!['push', 'pull', 'zoom'].includes(move)) return null;
  const zoom = readCameraMotionZoom(actionParams.zoom, move, actionParams.zoomDelta ?? actionParams.zoomLevel);
  return (
    <div className="inspector-row" key="camera-zoom">
      <span className="inspector-label">镜头缩放</span>
      <div className="compound-input">
        <FormSelect
          aria-label="镜头缩放类型"
          value={zoom.kind}
          options={[
            { value: 'absolute', label: '绝对' },
            { value: 'delta', label: '增量' },
          ]}
          onChange={(nextKind) => updateParam(actionId, 'zoom', serializeCameraMotionZoom({
            kind: nextKind as CameraMotionZoomKind,
            value: zoom.value,
          }))}
        />
        <InlineNumericInput
          ariaLabel="镜头缩放"
          dragLabel="值"
          step="0.05"
          min={zoom.kind === 'absolute' ? '0' : undefined}
          popoverMin={zoom.kind === 'absolute' ? '0.1' : '-1'}
          popoverMax={zoom.kind === 'absolute' ? '3' : '1'}
          value={zoom.value}
          onChange={(nextValue, isTransient) => updateParam(
            actionId,
            'zoom',
            serializeCameraMotionZoom({ kind: zoom.kind, value: nextValue }),
            isTransient,
          )}
        />
      </div>
    </div>
  );
  };

  if (!(actionType === 'cameraMotion' && action.semanticType !== 'camera')) return null;
  return (
          <div className="inspector-section">
            <div className="inspector-section-title">运镜参数</div>
            
            <div className="inspector-row">
              <label className="inspector-label" htmlFor={`action-${actionId}-camera-motion`}>运镜动作</label>
              <FormSelect id={`action-${actionId}-camera-motion`} value={currentMove} options={moveOptions} onChange={(value) => updateParam(actionId, 'move', value)} />
            </div>

            <div className="inspector-row">
              <label className="inspector-label" htmlFor={`action-${actionId}-camera-easing`}>情绪缓动</label>
              <FormSelect id={`action-${actionId}-camera-easing`} value={actionParams.easing || 'smooth'} options={[
                { value: 'smooth', label: '平滑' },
                { value: 'accelerate', label: '急出' },
                { value: 'overshoot', label: '回弹' },
                { value: 'linear', label: '匀速' },
                { value: 'decelerate', label: '缓入' },
                { value: 'bounce', label: '弹跳' },
                { value: 'anticipate', label: '预备' },
                { value: 'hesitate', label: '犹豫' },
              ]} onChange={(value) => updateParam(actionId, 'easing', value)} />
            </div>

            <div className="inspector-row">
              <label className="inspector-label" htmlFor={`action-${actionId}-camera-focus`}>对焦目标</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <FormSelect id={`action-${actionId}-camera-focus`}
                  value={(actionParams.focus && typeof actionParams.focus === 'object' ? actionParams.focus.character : '') || actionParams.characterId || ''}
                  options={[
                    { value: '', label: '固定坐标' },
                    ...(sceneData.meta.characters ?? []).map((character) => ({ value: character.id, label: character.name })),
                  ]}
                  onChange={(char) => {
                    const current = (actionParams.focus && typeof actionParams.focus === 'object') ? actionParams.focus : {};
                    updateParam(actionId, 'focus', { ...current, character: char || undefined });
                  }}
                />

                {((actionParams.focus && typeof actionParams.focus === 'object' && actionParams.focus.character) || actionParams.characterId) ? (
                  <div className="compound-input" style={{ marginTop: 4 }}>
                    <FormSelect
                      aria-label="对焦部位"
                      id={`action-${actionId}-camera-focus-part`}
                      value={(actionParams.focus && typeof actionParams.focus === 'object' ? actionParams.focus.part : '') || 'chest'}
                      options={[
                        { value: 'head', label: '头部' },
                        { value: 'chest', label: '胸部' },
                        { value: 'center', label: '中心' },
                      ]}
                      onChange={(value) => {
                        const current = (actionParams.focus && typeof actionParams.focus === 'object') ? actionParams.focus : {};
                        updateParam(actionId, 'focus', { ...current, part: value });
                      }}
                    />
                    <InlineNumericInput dragLabel="ΔX" step="0.01" popoverMin="-1" popoverMax="1" value={(actionParams.focus && typeof actionParams.focus === 'object' ? actionParams.focus.offsetX ?? 0 : 0)} onChange={(v, isTransient) => {
                      const current = (actionParams.focus && typeof actionParams.focus === 'object') ? actionParams.focus : {};
                      updateParam(actionId, 'focus', { ...current, offsetX: v }, isTransient);
                    }} />
                    <InlineNumericInput dragLabel="ΔY" step="0.01" popoverMin="-1" popoverMax="1" value={(actionParams.focus && typeof actionParams.focus === 'object' ? actionParams.focus.offsetY ?? 0 : 0)} onChange={(v, isTransient) => {
                      const current = (actionParams.focus && typeof actionParams.focus === 'object') ? actionParams.focus : {};
                      updateParam(actionId, 'focus', { ...current, offsetY: v }, isTransient);
                    }} />
                  </div>
                ) : (
                  <div className="compound-input grid-row" style={{ marginTop: 4 }}>
                    <InlineNumericInput dragLabel="X" step="0.01" min="0" max="1" value={(actionParams.focus && typeof actionParams.focus === 'object' ? (actionParams.focus.point?.[0] ?? 0.5) : 0.5)} onChange={(v, isT) => {
                        const current = (actionParams.focus && typeof actionParams.focus === 'object') ? actionParams.focus : {};
                        const pt = Array.isArray(current.point) ? [...current.point] : [0.5, 0.5];
                        pt[0] = Math.max(0, Math.min(1, v));
                        updateParam(actionId, 'focus', { ...current, point: pt }, isT);
                      }} />
                    <InlineNumericInput dragLabel="Y" step="0.01" min="0" max="1" value={(actionParams.focus && typeof actionParams.focus === 'object' ? (actionParams.focus.point?.[1] ?? 0.5) : 0.5)} onChange={(v, isT) => {
                        const current = (actionParams.focus && typeof actionParams.focus === 'object') ? actionParams.focus : {};
                        const pt = Array.isArray(current.point) ? [...current.point] : [0.5, 0.5];
                        pt[1] = Math.max(0, Math.min(1, v));
                        updateParam(actionId, 'focus', { ...current, point: pt }, isT);
                      }} />
                    <InlineNumericInput dragLabel="°" step="1" popoverMin="-180" popoverMax="180" value={actionParams.rotation || actionParams.angle || 0} onChange={(v, isT) => updateParam(actionId, 'rotation', v, isT)} />
                  </div>
                )}
              </div>
            </div>

            {renderLegacyCameraZoom()}
          </div>
  );
}
