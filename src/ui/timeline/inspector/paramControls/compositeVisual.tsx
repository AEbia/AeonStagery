// Composite-visual region: slot/mode/targetId selects, recipeId pickers,
// integration colorBlendMode, and the shared visual numeric overrides.
import React from 'react';
import {
  NumericInput,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import { BLEND_MODE_OPTIONS } from '../../blendModeOptions';
import { getCompositeSlotLabel, getRecipeDisplayLabel } from '../../visualPresentation';
import {
  listVisualRecipeIds,
  visualSemanticDefaults,
} from '../visualStyleLabels';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveCompositeVisualParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;
  const isComposite = ctx.actionType === 'setCompositeRecipe' || ctx.actionType === 'modulateComposite';

  if (isComposite && key === 'slot') {
    const currentSlot = String(val || 'integration');
    const slotOptions = [
      ...(currentSlot === 'grounding'
        ? [{ value: 'grounding', label: getCompositeSlotLabel('grounding') }]
        : []),
      { value: 'integration', label: getCompositeSlotLabel('integration') },
      { value: 'accent', label: getCompositeSlotLabel('accent') },
      { value: 'distortion', label: getCompositeSlotLabel('distortion') },
    ];
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={currentSlot} options={slotOptions} onChange={(value) => ctx.updateAuthoringParam(key, value)} />
      </div>
    );
  }

  if (isComposite && key === 'mode') {
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={val || 'latching'} options={[
          { value: 'latching', label: '设置' },
          { value: 'envelope', label: '调制' },
        ]} onChange={(value) => ctx.updateAuthoringParam(key, value)} />
      </div>
    );
  }

  if (isComposite && key === 'targetId') {
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={val || 'background'} options={ctx.visualTargetOptions} onChange={(value) => ctx.updateAuthoringParam(key, value)} />
      </div>
    );
  }

  if (ctx.isIntegrationVisualAction && key === 'colorBlendMode') {
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={val || 'multiply'} options={BLEND_MODE_OPTIONS} onChange={(value) => ctx.action.semanticType === 'visualStyle' ? ctx.updateSemanticSourceParam(key, value) : ctx.updateAuthoringParam(key, value)} />
      </div>
    );
  }

  if (isComposite && key === 'recipeId' && ctx.recipeOptions.length > 0) {
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
        <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={val || ctx.recipeOptions[0]?.value || ''} options={ctx.recipeOptions} onChange={(value) => ctx.action.semanticType === 'visualStyle' ? ctx.updateSemanticSourceParam(key, value) : ctx.updateAuthoringParam(key, value)} />
      </div>
    );
  }

  if (ctx.action.semanticType === 'visualStyle' && key === 'recipeId' && !ctx.isRimLightVisualAction) {
    const options = listVisualRecipeIds(ctx.sceneData.visual, 'object', ctx.visualSlot)
      .map((recipeId) => ({ value: recipeId, label: getRecipeDisplayLabel(ctx.sceneData.visual, recipeId) }));
    if (options.length > 0) {
      return (
        <div className="inspector-row" key={key}>
          <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
          <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={typeof val === 'string' ? val : options[0].value} options={options} onChange={(value) => ctx.updateSemanticSourceParam(key, value)} />
        </div>
      );
    }
  }

  if ((ctx.isCompositeVisualAction || ctx.isLensFilterSourceAction)
    && (key !== 'brightness' || ctx.isIntegrationVisualAction)
    && ['intensity', 'brightness', 'warmth', 'bloom', 'rgbSplit', 'blend', 'contamination'].includes(key)) {
    const defaultValue = visualSemanticDefaults[key] ?? 0;
    const currentValue = typeof val === 'number' ? val : defaultValue;
    const step = key === 'warmth' ? '0.05' : '0.05';
    const min = key === 'warmth' || key === 'brightness' ? '-1' : '0';
    const max = key === 'brightness' ? '1' : undefined;
    return (
      <NumericInput
        key={key}
        label={base.label}
        value={currentValue}
        step={step}
        min={min}
        max={max}
        dataTestId={base.paramTestId}
        onChange={(nextValue, isTransient) => ctx.action.semanticType === 'visualStyle'
          ? ctx.updateSemanticSourceParam(key, nextValue, isTransient)
          : ctx.updateParam(ctx.actionId, key, nextValue, isTransient)}
      />
    );
  }

  return undefined;
}
