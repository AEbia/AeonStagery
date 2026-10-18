// Compound-coordinate region: position / x-y-z / scale-rotation-opacity groups
// and generic [number, number] pairs.
import React from 'react';
import { InlineNumericInput } from '../../FormComponents';
import type { InspectorParamContext, ParamControlBase } from './context';
import type { NumericInputGesture } from '../../FormComponents';

function updateNumericParam(ctx: InspectorParamContext, key: string, value: unknown, isTransient?: boolean, gesture?: NumericInputGesture): void {
  if (gesture) ctx.updateParam(ctx.actionId, key, value, isTransient, gesture);
  else ctx.updateParam(ctx.actionId, key, value, isTransient);
}

const UNBOUNDED_POSITION_ACTIONS = new Set([
  'addCharacter',
  'transformCharacter',
  'setEnvironmentLayer',
  'transformEnvironmentLayer',
  'addImage',
  'transformImage',
  'addTextLayer',
  'transformTextLayer',
]);

export function resolveCompoundParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;
  if (key === 'position' || (key === 'z' && !ctx.allKeys.includes('position') && !ctx.allKeys.includes('x'))) {
    if (key === 'z' && (ctx.allKeys.includes('position') || ctx.allKeys.includes('x'))) return null; // Handled by position/x
    if (key === 'position') {
      const val = ctx.actionParams.position || [0.5, 0.8];
      const zVal = ctx.actionParams.z ?? 0;
      const positionBounds = UNBOUNDED_POSITION_ACTIONS.has(ctx.actionType)
        ? { inferNormalizedBounds: false, popoverMin: '0', popoverMax: '1' }
        : { min: '0', max: '1' };
      return (
        <div className="inspector-row" key="position_xyz">
          <span className="inspector-label">空间坐标</span>
          <div className="compound-input grid-row">
            <InlineNumericInput dragLabel="X" step="0.01" {...positionBounds} value={val[0]} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, 'position', [v, val[1]], isTransient, gesture)} />
            <InlineNumericInput dragLabel="Y" step="0.01" {...positionBounds} value={val[1]} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, 'position', [val[0], v], isTransient, gesture)} />
            <InlineNumericInput dragLabel="Z" step="10" popoverMin="-100" popoverMax="100" value={zVal} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, 'z', v, isTransient, gesture)} />
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
            <InlineNumericInput dragLabel="X" step={xyStep} inferNormalizedBounds={false} popoverMin="0" popoverMax="1" value={xVal} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, 'x', v, isTransient, gesture)} />
            <InlineNumericInput dragLabel="Y" step={xyStep} inferNormalizedBounds={false} popoverMin="0" popoverMax="1" value={yVal} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, 'y', v, isTransient, gesture)} />
            {hasZ && (
              <InlineNumericInput dragLabel="Z" step="10" popoverMin="-100" popoverMax="100" value={zVal} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, 'z', v, isTransient, gesture)} />
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
          <InlineNumericInput dragLabel="缩放" step="0.05" min="0.05" popoverMin="0.1" popoverMax="3" value={ctx.actionParams.scale ?? 1} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, 'scale', v, isTransient, gesture)} />
          <InlineNumericInput dragLabel="旋转" step="1" popoverMin="-180" popoverMax="180" value={ctx.actionParams.rotation ?? 0} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, 'rotation', v, isTransient, gesture)} />
          <InlineNumericInput dragLabel="透明" step="0.05" min="0" max="1" value={ctx.actionParams.opacity ?? 1} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, 'opacity', v, isTransient, gesture)} />
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
          <InlineNumericInput dragLabel="X" step="0.01" inferNormalizedBounds={false} popoverMin="0" popoverMax="1" value={val[0]} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, key, [v, val[1]], isTransient, gesture)} />
          <InlineNumericInput dragLabel="Y" step="0.01" inferNormalizedBounds={false} popoverMin="0" popoverMax="1" value={val[1]} onGestureStart={ctx.registerNumericGesture} onChange={(v, isTransient, gesture) => updateNumericParam(ctx, key, [val[0], v], isTransient, gesture)} />
        </div>
      </div>
    );
  }

  return undefined;
}
