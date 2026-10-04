// Color family region: color-key pickers, visualStyle semanticOverride editor,
// integration colorStops editor.
import React from 'react';
import { ColorPickerInput } from '../../../ColorPickerInput';
import {
  InlineNumericInput,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import { BLEND_MODE_OPTIONS } from '../../blendModeOptions';
import { asRecord } from '../asRecord';
import {
  getVisualStyleOverrideConfig,
  getVisualStyleOverrideLabel,
  VISUAL_STYLE_OVERRIDE_KEYS,
} from '../visualStyleLabels';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveColorAndOverrideParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;

  if (['speakerColor', 'textColor', 'color'].includes(key)) {
    return (
      <div className="inspector-row" key={key}>
        <span className="inspector-label">{base.label}</span>
        <div className="compound-input" style={{ height: '26px', padding: '1px 1px' }}>
          <ColorPickerInput aria-label={`${base.label}颜色选择器`} style={{ width: 22, height: 22, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent', borderRadius: 'var(--radius-sm)' }} value={val || '#ffffff'} onChange={(color) => ctx.updateAuthoringParam(key, color)} />
          <input type="text" aria-label={base.label} style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '0 6px', fontSize: 11, color: 'var(--text-primary)', outline: 'none' }} value={val || ''} onChange={(e) => ctx.updateAuthoringParam(key, e.target.value)} />
        </div>
      </div>
    );
  }

  if (ctx.action.semanticType === 'visualStyle' && key === 'semanticOverride') {
    const override = asRecord(ctx.actionParams.semanticOverride);
    const overrideKeys = VISUAL_STYLE_OVERRIDE_KEYS[ctx.visualSlot] ?? [];
    if (overrideKeys.length === 0) return null;

    return (
      <div className="inspector-row stacked" key={key}>
        <span className="inspector-label">风格微调</span>
        <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
          {overrideKeys.map((overrideKey) => {
            const overrideLabel = getVisualStyleOverrideLabel(ctx.visualSlot, overrideKey);
            const overrideValue = override[overrideKey];
            if (overrideKey === 'colorStops') {
              const sourceStops = Array.isArray(overrideValue) ? overrideValue : [];
              const stopLabels = ['左上', '右上', '左下', '右下'];
              const rawStops = stopLabels.map((_, index) => String(sourceStops[index] || '#ffffff'));
              const colorInputStops = rawStops.map((stop) => (/^#[0-9a-f]{6}$/i.test(stop) ? stop : '#ffffff'));
              const updateStop = (index: number, nextValue: string) => {
                const nextStops = [...rawStops];
                nextStops[index] = nextValue;
                ctx.updateVisualSemanticOverride('colorStops', nextStops);
              };
              return (
                <div className="inspector-row" key={overrideKey}>
                  <span className="inspector-label">{overrideLabel}</span>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, minWidth: 0 }}>
                    {rawStops.map((stop, index) => (
                      <div className="compound-input" key={stopLabels[index]} style={{ height: '26px', padding: '1px 1px' }}>
                        <span style={{ width: 24, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>{stopLabels[index]}</span>
                        <ColorPickerInput aria-label={`风格微调${stopLabels[index]}色标选择器`} style={{ width: 22, height: 22, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent', borderRadius: 'var(--radius-sm)' }} value={colorInputStops[index]} onChange={(color) => updateStop(index, color)} />
                        <input type="text" aria-label={`风格微调${stopLabels[index]}色标`} style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '0 4px', fontSize: 10, color: 'var(--text-primary)', outline: 'none' }} value={stop} onChange={(event) => updateStop(index, event.target.value)} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            }
            if (overrideKey === 'color') {
              const colorValue = typeof overrideValue === 'string' ? overrideValue : '#ffffff';
              return (
                <div className="inspector-row" key={overrideKey}>
                  <span className="inspector-label">{overrideLabel}</span>
                  <div className="compound-input" style={{ height: '26px', padding: '1px 1px' }}>
                    <ColorPickerInput aria-label={`风格微调${overrideLabel}选择器`} style={{ width: 22, height: 22, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent', borderRadius: 'var(--radius-sm)' }} value={/^#[0-9a-f]{6}$/i.test(colorValue) ? colorValue : '#ffffff'} onChange={(color) => ctx.updateVisualSemanticOverride(overrideKey, color)} />
                    <input type="text" aria-label={`风格微调${overrideLabel}`} style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '0 6px', fontSize: 11, color: 'var(--text-primary)', outline: 'none' }} value={colorValue} onChange={(event) => ctx.updateVisualSemanticOverride(overrideKey, event.target.value)} />
                  </div>
                </div>
              );
            }
            if (overrideKey === 'colorBlendMode') {
              return (
                <div className="inspector-row" key={overrideKey}>
                  <label className="inspector-label" htmlFor={`${base.fieldId}-${overrideKey}`}>{overrideLabel}</label>
                  <FormSelect id={`${base.fieldId}-${overrideKey}`} value={typeof overrideValue === 'string' ? overrideValue : 'multiply'} options={BLEND_MODE_OPTIONS} onChange={(value) => ctx.updateVisualSemanticOverride(overrideKey, value)} />
                </div>
              );
            }
            const overrideConfig = getVisualStyleOverrideConfig(overrideKey);
            return (
              <div className="inspector-row" key={overrideKey}>
                <span className="inspector-label">{overrideLabel}</span>
                <InlineNumericInput
                  ariaLabel={`风格微调${overrideLabel}`}
                  dragLabel="值"
                  step={overrideConfig.step ?? "0.05"}
                  min={overrideConfig.min}
                  max={overrideConfig.max}
                  popoverMin={overrideConfig.popoverMin}
                  popoverMax={overrideConfig.popoverMax}
                  value={typeof overrideValue === 'number' ? overrideValue : 0}
                  onChange={(value, isTransient) => ctx.updateVisualSemanticOverride(overrideKey, value, isTransient)}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (ctx.isIntegrationVisualAction && key === 'colorStops') {
    const sourceStops = Array.isArray(val)
      ? val
      : typeof val === 'string'
        ? val.split(/[,\s]+/).filter(Boolean)
        : [];
    const stopLabels = ['左上', '右上', '左下', '右下'];
    const rawStops = stopLabels.map((_, index) => String(sourceStops[index] || '#ffffff'));
    const colorInputStops = rawStops.map((stop) => (/^#[0-9a-f]{6}$/i.test(stop) ? stop : '#ffffff'));
    const updateStop = (index: number, nextValue: string) => {
      const nextStops = [...rawStops];
      nextStops[index] = nextValue;
      ctx.updateAuthoringParam(key, nextStops);
    };

    return (
      <div className="inspector-row" key={key}>
        <span className="inspector-label">{base.label}</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, minWidth: 0 }}>
          {rawStops.map((stop, index) => (
            <div className="compound-input" key={stopLabels[index]} style={{ height: '26px', padding: '1px 1px' }}>
              <span style={{ width: 24, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>{stopLabels[index]}</span>
              <ColorPickerInput aria-label={`${stopLabels[index]}色标选择器`} style={{ width: 22, height: 22, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent', borderRadius: 'var(--radius-sm)' }} value={colorInputStops[index]} onChange={(color) => updateStop(index, color)} />
              <input type="text" aria-label={`${stopLabels[index]}色标`} style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '0 4px', fontSize: 10, color: 'var(--text-primary)', outline: 'none' }} value={stop} onChange={(e) => updateStop(index, e.target.value)} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return undefined;
}
