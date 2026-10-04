// Terminal region of the dispatch chain: typed fallback controls.
import React from 'react';
import { NumericInput, TextArea, TextInput } from '../../FormComponents';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveFallbackParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;

  if (typeof val === 'number') {
    return (
      <NumericInput
        key={key}
        label={base.label}
        value={val}
        min={base.catalogField?.min}
        max={base.catalogField?.max}
        popoverMin={base.catalogField?.popoverMin}
        popoverMax={base.catalogField?.popoverMax}
        step={base.catalogField?.step}
        dataTestId={base.paramTestId}
        onChange={(v, isTransient) => ctx.updateAuthoringParam(key, v, isTransient)}
      />
    );
  }

  if (typeof val === 'boolean') {
    const checkboxId = `action-${ctx.actionId}-param-${key}`;
    return (
      <div className="inspector-row" key={key}>
        <div />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input id={checkboxId} type="checkbox" checked={val} onChange={(e) => ctx.updateAuthoringParam(key, e.target.checked)} />
          <label htmlFor={checkboxId} className="inspector-label" style={{ margin: 0, textAlign: 'left' }}>{base.label}</label>
        </div>
      </div>
    );
  }

  if ((ctx.actionType === 'dialogue' || ctx.actionType === 'addTextLayer') && key === 'text') {
    return <TextArea key={key} label="文本内容" value={val || ''} dataTestId={base.paramTestId} onChange={(v) => ctx.updateParam(ctx.actionId, key, v)} />;
  }

  return <TextInput key={key} label={base.label} value={val || ''} dataTestId={base.paramTestId} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
}
