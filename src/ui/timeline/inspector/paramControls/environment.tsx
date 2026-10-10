import React from 'react';
import { TextInput } from '../../FormComponents';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveEnvironmentParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  if (key === 'label' && ctx.isEnvironmentLayerAuthoringAction) return null;
  if (key !== 'layerId' || !ctx.isEnvironmentLayerAuthoringAction) return undefined;
  if (ctx.rowFieldKeys?.has(key)) return null;

  return <TextInput
    label="环境图层 ID"
    value={typeof ctx.sourceParams.layerId === 'string' ? ctx.sourceParams.layerId : ''}
    dataTestId={base.paramTestId}
    onChange={(value) => ctx.updateAuthoringParam('layerId', value)}
  />;
}
