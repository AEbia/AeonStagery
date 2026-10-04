// Catalog-driven controls from semanticInspectorFieldCatalog value types.
// Two resolvers are exported because the original chain interleaves other
// families between them (boolean first, number later).
import React from 'react';
import { NumericInput } from '../../FormComponents';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveCatalogBooleanParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  if (base.catalogField?.valueType === 'boolean' && typeof base.val !== 'boolean') {
    const checkboxId = `action-${ctx.actionId}-param-${key}`;
    return (
      <div className="inspector-row" key={key}>
        <div />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input id={checkboxId} type="checkbox" checked={false} onChange={(e) => ctx.updateParam(ctx.actionId, key, e.target.checked)} />
          <label htmlFor={checkboxId} className="inspector-label" style={{ margin: 0, textAlign: 'left' }}>{base.label}</label>
        </div>
      </div>
    );
  }
  return undefined;
}

export function resolveCatalogNumberParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  if (base.catalogField?.valueType === 'number') {
    const currentValue = typeof base.val === 'number' ? base.val : 0;
    return (
      <NumericInput
        key={key}
        label={base.label}
        value={currentValue}
        min={base.catalogField?.min}
        max={base.catalogField?.max}
        popoverMin={base.catalogField?.popoverMin}
        popoverMax={base.catalogField?.popoverMax}
        step={base.catalogField?.step}
        dataTestId={base.paramTestId}
        onChange={(nextValue, isTransient) => {
          if (ctx.action.semanticType === 'lighting' || ctx.action.semanticType === 'visualStyle') ctx.updateSemanticSourceParam(key, nextValue, isTransient);
          else ctx.updateParam(ctx.actionId, key, nextValue, isTransient);
        }}
      />
    );
  }
  return undefined;
}
