// Compound-coordinate region: position / x-y-z / scale-rotation-opacity groups
// and generic [number, number] pairs.
import React from 'react';
import { InlineNumericInput } from '../../FormComponents';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveCompoundParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;
  if (key === 'position' || (key === 'z' && !ctx.allKeys.includes('position') && !ctx.allKeys.includes('x'))) {
    if (key === 'z' && (ctx.allKeys.includes('position') || ctx.allKeys.includes('x'))) return null; // Handled by position/x
    if (key === 'position') {
      const val = ctx.actionParams.position || [0.5, 0.8];
      const zVal = ctx.actionParams.z ?? 0;
      const positionBounds = ['addCharacter', 'transformCharacter'].includes(ctx.actionType)
        ? { inferNormalizedBounds: false, popoverMin: '0', popoverMax: '1' }
        : { min: '0', max: '1' };
      return (
        <div className="inspector-row" key="position_xyz">
          <span className="inspector-label">空间坐标</span>
          <div className="compound-input grid-row">
            <InlineNumericInput dragLabel="X" step="0.01" {...positionBounds} value={val[0]} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, 'position', [v, val[1]], isTransient)} />
            <InlineNumericInput dragLabel="Y" step="0.01" {...positionBounds} value={val[1]} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, 'position', [val[0], v], isTransient)} />
            <InlineNumericInput dragLabel="Z" step="10" popoverMin="-100" popoverMax="100" value={zVal} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, 'z', v, isTransient)} />
          </div>
        </div>
      );
    }
  }

  if (key === 'x' || key === 'y' || (key === 'z' && !ctx.allKeys.includes('position') && ctx.allKeys.includes('x'))) {
    if ((key === 'y' || key === 'z') && ctx.allKeys.includes('x')) return null; // Handled by x
    if (key === 'x') {
      const xVal = ctx.actionParams.x ?? 0;
      const yVal = ctx.actionParams.y ?? 0;
      const zVal = ctx.actionParams.z ?? 0;
      const hasZ = ctx.allKeys.includes('z');
      const xyStep = ['setEnvironmentLayer', 'transformEnvironmentLayer'].includes(ctx.actionType) ? '0.01' : '1';
      return (
        <div className="inspector-row" key="position_xyz_separate">
          <span className="inspector-label">空间坐标</span>
          <div className="compound-input grid-row">
            <InlineNumericInput dragLabel="X" step={xyStep} min="0" max="1" value={xVal} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, 'x', v, isTransient)} />
            <InlineNumericInput dragLabel="Y" step={xyStep} min="0" max="1" value={yVal} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, 'y', v, isTransient)} />
            {hasZ && (
              <InlineNumericInput dragLabel="Z" step="10" popoverMin="-100" popoverMax="100" value={zVal} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, 'z', v, isTransient)} />
            )}
          </div>
        </div>
      );
    }
  }

  if (key === 'z' && (ctx.allKeys.includes('position') || ctx.allKeys.includes('x'))) return null;

  const hasTransformGroup = ctx.allKeys.includes('scale') && ctx.allKeys.includes('rotation') && ctx.allKeys.includes('opacity');
  if (key === 'scale' && hasTransformGroup) {
    return (
      <div className="inspector-row" key="transform_group">
        <span className="inspector-label">基础变换</span>
        <div className="compound-input grid-row">
          <InlineNumericInput dragLabel="缩放" step="0.05" min="0.05" popoverMin="0.1" popoverMax="3" value={ctx.actionParams.scale ?? 1} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, 'scale', v, isTransient)} />
          <InlineNumericInput dragLabel="旋转" step="1" popoverMin="-180" popoverMax="180" value={ctx.actionParams.rotation ?? 0} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, 'rotation', v, isTransient)} />
          <InlineNumericInput dragLabel="透明" step="0.05" min="0" max="1" value={ctx.actionParams.opacity ?? 1} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, 'opacity', v, isTransient)} />
        </div>
      </div>
    );
  }
  if ((key === 'rotation' || key === 'opacity') && hasTransformGroup) return null;

  if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number') {
    return (
      <div className="inspector-row" key={key}>
        <span className="inspector-label">{base.label}</span>
        <div className="compound-input">
          <InlineNumericInput dragLabel="X" step="0.01" min="0" max="1" value={val[0]} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, key, [v, val[1]], isTransient)} />
          <InlineNumericInput dragLabel="Y" step="0.01" min="0" max="1" value={val[1]} onChange={(v, isTransient) => ctx.updateParam(ctx.actionId, key, [val[0], v], isTransient)} />
        </div>
      </div>
    );
  }

  return undefined;
}
