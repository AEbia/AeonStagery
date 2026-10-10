// Per-family single-line selects in the dispatch tail (lighting preset, blur,
// dialogue style/lipSync/position/template, blink intervals, environment
// layout/transition, character enter/exit, ease, animation layer, ...).
import React from 'react';
import {
  BlurTargetSelect,
  DialoguePositionSelect,
  DialogueStyleSelect,
  DialogueTemplateSelect,
  DirectionSelect,
  EaseSelect,
  EnvironmentLayoutSelect,
  EnterAnimationSelect,
  ExitAnimationSelect,
  FontFamilySelect,
  LayerSelect,
  LightingPresetSelect,
  LipSyncSelect,
  NumericInput,
  TransitionSelect,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import { LightingTargetPicker } from '../../LightingTargetPicker';
import type { InspectorParamContext, ParamControlBase } from './context';

export function resolveMiscSelectParam(ctx: InspectorParamContext, key: string, base: ParamControlBase): React.ReactNode | undefined {
  const { val } = base;
  const actionType = ctx.actionType;

  if ((actionType === 'setLighting' || ctx.action.semanticType === 'lighting') && key === 'preset') return <LightingPresetSelect key={key} value={val || ''} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
  if (ctx.action.semanticType === 'lighting' && ctx.actionParams.effect === 'post' && key === 'target') {
    return (
      <LightingTargetPicker
        key={key}
        id={base.fieldId}
        dataTestId={base.paramTestId}
        value={typeof val === 'string' && val.trim() ? val : 'panorama'}
        characters={ctx.sceneData.meta.characters ?? []}
        environmentLayers={ctx.environmentLayers}
        onChange={(value) => ctx.updateAuthoringParam(key, value)}
      />
    );
  }
  if ((actionType === 'setBlur' || actionType === 'resetBlur' || ctx.action.semanticType === 'lighting') && key === 'target') {
    const defaultTarget = ctx.action.semanticType === 'lighting'
      ? 'global'
      : actionType === 'resetBlur' ? 'all' : 'global';
    return <BlurTargetSelect key={key} value={val || defaultTarget} onChange={(v) => ctx.action.semanticType === 'lighting' ? ctx.updateAuthoringParam(key, v) : ctx.updateParam(ctx.actionId, key, v)} />;
  }
  if ((actionType === 'dialogue' || actionType === 'addTextLayer') && key === 'style') return <DialogueStyleSelect key={key} value={val || 'typewriter'} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
  if (ctx.action.semanticType === 'dialogue' && key === 'lipSync') {
    const checkboxId = `action-${ctx.actionId}-param-lipSync`;
    return (
      <div className="inspector-row" key={key}>
        <div />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id={checkboxId}
            type="checkbox"
            checked={ctx.actionParams.lipSync ?? true}
            onChange={(event) => ctx.updateParam(ctx.actionId, key, event.target.checked)}
          />
          <label htmlFor={checkboxId} className="inspector-label" style={{ margin: 0, textAlign: 'left' }}>{base.label}</label>
        </div>
      </div>
    );
  }
  if (actionType === 'characterBlink' && ctx.action.semanticType !== 'characterPerformance' && key === 'interval') {
    const intervalMs = typeof val === 'number' ? val : 4000;
    return (
      <NumericInput
        key={key}
        label="眨眼间隔（秒）"
        value={intervalMs / 1000}
        dataTestId={base.paramTestId}
        onChange={(seconds, isTransient) => ctx.updateParam(ctx.actionId, key, Math.max(0, seconds) * 1000, isTransient)}
      />
    );
  }
  if (actionType === 'characterBlink' && ctx.action.semanticType !== 'characterPerformance' && key === 'intervalRange') {
    const rangeVal = typeof val === 'number' ? val : 0;
    return (
      <NumericInput
        key={key}
        label="随机范围（秒）"
        min="0"
        value={rangeVal}
        dataTestId={base.paramTestId}
        onChange={(seconds, isTransient) => ctx.updateParam(ctx.actionId, key, Math.max(0, seconds), isTransient)}
      />
    );
  }
  if (actionType === 'dialogue' && key === 'lipSync') return <LipSyncSelect key={key} value={val || 'text'} onChange={(v) => ctx.updateParam(ctx.actionId, key, v)} />;
  if (actionType === 'dialogue' && key === 'position') return <DialoguePositionSelect key={key} value={val || 'bottom'} onChange={(v) => ctx.updateParam(ctx.actionId, key, v)} />;
  if (key === 'fontFamily') return <FontFamilySelect key={key} value={val || ''} onChange={(v) => ctx.updateParam(ctx.actionId, key, v)} />;
  if (actionType === 'dialogue' && key === 'template') return (
    <DialogueTemplateSelect
      key={key}
      value={ctx.currentDialogueTemplateValue}
      customOptions={ctx.customDialogueTemplateOptions}
      onChange={(value) => { void ctx.updateDialogueTemplate(value); }}
    />
  );
  if (actionType === 'addColorOverlay' && key === 'mode') return (
    <div className="inspector-row" key={key}>
      <label className="inspector-label" htmlFor={base.fieldId}>{base.label}</label>
      <FormSelect id={base.fieldId} data-testid={base.paramTestId} value={val || 'multiply'} options={[
        { value: 'multiply', label: '正片叠底 (Multiply)' },
        { value: 'screen', label: '滤色 (Screen)' },
      ]} onChange={(value) => ctx.updateAuthoringParam(key, value)} />
    </div>
  );
  if (actionType === 'cameraShake' && key === 'direction') return <DirectionSelect key={key} value={val || 'both'} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
  if (actionType === 'setEnvironmentLayer' && key === 'layoutMode') {
    return <EnvironmentLayoutSelect key={key} value={val || 'cover'} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
  }
  if (['setEnvironmentLayer', 'removeEnvironmentLayer'].includes(actionType) && key === 'transition') {
    const defaultTransition = actionType === 'removeEnvironmentLayer' ? 'fadeOut' : 'none';
    return <TransitionSelect key={key} value={val || defaultTransition} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
  }
  if (ctx.action.semanticType === 'characterPresence' && key === 'transition') {
    return ctx.actionParams.mode === 'exit'
      ? <ExitAnimationSelect key={key} value={val || 'none'} onChange={(v) => ctx.updateAuthoringParam(key, v)} />
      : <EnterAnimationSelect key={key} value={val || 'none'} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
  }
  if (actionType === 'addCharacter' && key === 'enter') return <EnterAnimationSelect key={key} value={val || 'none'} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
  if (actionType === 'removeCharacter' && key === 'exit') return <ExitAnimationSelect key={key} value={val || 'none'} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
  if (key === 'ease' || key === 'enterEase') return <EaseSelect key={key} label={base.label} value={val || ''} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;
  if (actionType === 'playCustomAnimation' && key === 'layer') return <LayerSelect key={key} value={val || 'overlay'} onChange={(v) => ctx.updateAuthoringParam(key, v)} />;

  return undefined;
}
