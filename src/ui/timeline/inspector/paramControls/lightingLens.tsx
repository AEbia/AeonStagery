// Lighting + lens-filter region: color rows, overlay blend/intensity, blendMode,
// and the lens filter transition duration control.
import React from 'react';
import {
  ColorPickerRow,
  InlineNumericInput,
  NumericInput,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import { BLEND_MODE_OPTIONS } from '../../blendModeOptions';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveLightingLensParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;

  if (ctx.action.semanticType === 'lighting' && key === 'color') {
    return (
      <ColorPickerRow
        key={key}
        label={base.label}
        value={typeof val === 'string' ? val : '#ffffff'}
        dataTestId={base.paramTestId}
        onChange={(nextColor) => ctx.updateAuthoringParam(key, nextColor)}
      />
    );
  }

  if (ctx.action.semanticType === 'lighting' && ctx.actionParams.effect === 'post' && key === 'overlayColor') {
    return (
      <ColorPickerRow
        key={key}
        label={base.label}
        value={typeof val === 'string' ? val : '#000000'}
        dataTestId={base.paramTestId}
        onChange={(nextColor) => ctx.updateAuthoringParam(key, nextColor)}
      />
    );
  }

  if (ctx.action.semanticType === 'lighting' && ctx.actionParams.effect === 'post' && key === 'overlayBlendMode') {
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={typeof val === 'string' ? val : 'multiply'} options={BLEND_MODE_OPTIONS} onChange={(value) => ctx.updateAuthoringParam(key, value)} />
      </div>
    );
  }

  if (ctx.action.semanticType === 'lighting' && ctx.actionParams.effect === 'post' && key === 'overlayIntensity') {
    return (
      <NumericInput
        key={key}
        label={base.label}
        value={typeof val === 'number' ? val : 0.5}
        min={base.catalogField?.min ?? '0'}
        max={base.catalogField?.max ?? '1'}
        step={base.catalogField?.step ?? '0.05'}
        dataTestId={base.paramTestId}
        onChange={(nextValue, isTransient) => ctx.updateAuthoringParam(key, nextValue, isTransient)}
      />
    );
  }

  if (ctx.action.semanticType === 'lighting' && key === 'blendMode') {
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={typeof val === 'string' ? val : 'multiply'} options={BLEND_MODE_OPTIONS} onChange={(value) => ctx.updateSemanticSourceParam(key, value)} />
      </div>
    );
  }

  if (ctx.isLensFilterSourceAction && key === 'durationSeconds') {
    return (
      <div className="inspector-row" key={key}>
        <span className="inspector-label">{base.label}</span>
        <InlineNumericInput
          value={typeof val === 'number' ? val : 0}
          step="0.1"
          min="0"
          popoverMin="0"
          popoverMax="5"
          dragLabel="秒"
          ariaLabel="过渡时长（秒）"
          dataTestId={base.paramTestId}
          onChange={(nextValue, isTransient) => ctx.updateParam(ctx.actionId, key, Math.max(0, nextValue), isTransient)}
        />
      </div>
    );
  }

  return undefined;
}
