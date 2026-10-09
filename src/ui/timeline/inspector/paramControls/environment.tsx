// Environment-layer region: label suppression + layerId pickers.
import React from 'react';
import {
  EnvironmentLayerNameInput,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import { SearchableSelect } from '../../../SearchableSelect';
import { resolveEnvironmentLayerSelection } from '../../environmentAuthoring';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveEnvironmentParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  if (key === 'label' && ctx.isEnvironmentLayerAuthoringAction) {
    return null;
  }

  if (key === 'layerId' && ctx.actionType === 'setEnvironmentLayer') {
    if (ctx.rowFieldKeys?.has(key)) return null;
    return (
      <EnvironmentLayerNameInput
        key={key}
        label="环境层名称"
        value={ctx.currentEnvironmentLayer?.displayLabel || ctx.displayAction.params.label || '背景'}
        options={ctx.environmentLayers.map((layer) => layer.displayLabel)}
        placeholder="输入新层名或选择已有层名"
        onChange={(nextName) => {
          const trimmedName = nextName.trim();
          if (!trimmedName) return;
          const selection = resolveEnvironmentLayerSelection(ctx.sceneData, trimmedName);
          // 已存在层若无 authoredLabel（遗留数据）必须显式清空，避免残留上一层的 label
          const nextLabel = selection.isExisting
            ? (selection.layerId === 'background' || !selection.label ? null : selection.label)
            : selection.label;
          ctx.commitEnvironmentLayerReference(selection.layerId, nextLabel);
        }}
      />
    );
  }

  if (key === 'layerId' && ['transformEnvironmentLayer', 'removeEnvironmentLayer'].includes(ctx.actionType)) {
    if (ctx.rowFieldKeys?.has(key)) return (
      <SearchableSelect label="作用环境层" triggerLabel="选择环境层…"
        value={ctx.currentEnvironmentLayer?.layerId || 'background'}
        options={ctx.environmentLayers.map((layer) => ({ value: layer.layerId, label: layer.displayLabel }))}
        onChange={(value) => {
          const matched = ctx.environmentLayers.find((layer) => layer.layerId === value);
          ctx.commitEnvironmentLayerReference(value, matched?.isBackground ? null : (matched?.authoredLabel ?? null));
        }} />
    );
    return (
      <div className="inspector-row" key={key}>
        <label className="inspector-label" htmlFor={base.fieldId}>作用环境层</label>
        <FormSelect
          id={base.fieldId}
          data-testid={base.paramTestId}
          value={ctx.currentEnvironmentLayer?.layerId || 'background'}
          options={ctx.environmentLayers.map((layer) => ({ value: layer.layerId, label: layer.displayLabel }))}
          onChange={(value) => {
            const matched = ctx.environmentLayers.find((layer) => layer.layerId === value);
            ctx.commitEnvironmentLayerReference(value, matched?.isBackground ? null : (matched?.authoredLabel ?? null));
          }}
        />
      </div>
    );
  }

  return undefined;
}
