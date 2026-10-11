import { useId } from 'react';
import type { SceneVisualBlock } from '../../api/types/visual';
import { FormSelect } from '../FormSelect';
import { InlineNumericInput } from './FormComponents';
import { BLEND_MODE_OPTIONS } from './blendModeOptions';

type Params = Readonly<Record<string, unknown>>;

function overrideOf(params: Params): Record<string, unknown> | undefined {
  const value = params.semanticOverride;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

// The resolver treats semanticOverride as a complete replacement, not a patch.
export function integrationValues(params: Params): Params {
  return overrideOf(params) ?? params;
}

export function updateIntegrationValue(params: Params, key: string, value: unknown): Record<string, unknown> {
  const override = overrideOf(params);
  return override
    ? { ...params, semanticOverride: { ...override, [key]: value } }
    : { ...params, [key]: value };
}

interface Props {
  params: Params;
  sceneVisual?: SceneVisualBlock;
  targets: Array<{ value: string; label: string; disabled?: boolean }>;
  targetKey?: 'target' | 'targetId';
  durationKey?: 'durationSeconds' | 'duration';
  mode?: 'set' | 'modulate' | 'reset';
  rowFieldKeys?: ReadonlySet<string>;
  onChange: (params: Record<string, unknown>) => void;
}

/** Shared by standalone, legacy and dialogue-companion integration editors. */
export function CharacterIntegrationControls({ params, targets, targetKey = 'target', durationKey = 'durationSeconds', mode = 'set', rowFieldKeys, onChange }: Props) {
  const id = useId();
  const values = integrationValues(params);
  const setValue = (key: string, value: unknown) => onChange(updateIntegrationValue(params, key, value));
  const target = typeof params[targetKey] === 'string' ? params[targetKey] as string : '';
  const targetOptions = targets.some((option) => option.value === target) || !target
    ? targets
    : [{ value: target, label: `当前角色（${target}）` }, ...targets];
  const numeric = (key: string, label: string, fallback: number, min: string, max?: string, popoverMin?: string, popoverMax?: string) => rowFieldKeys?.has(key) ? null : (
    <div className="inspector-row" key={key}>
      <span className="inspector-label">{label}</span>
      <InlineNumericInput ariaLabel={label} value={typeof values[key] === 'number' ? values[key] as number : fallback}
        step="0.05" min={min} max={max} popoverMin={popoverMin} popoverMax={popoverMax} onChange={(value, transient) => { if (!transient) setValue(key, value); }} />
    </div>
  );
  return (
    <div className="character-integration-controls">
      {!rowFieldKeys?.has(targetKey) && <div className="inspector-row">
        <label className="inspector-label" htmlFor={`${id}-target`}>角色</label>
        <FormSelect id={`${id}-target`} value={target} options={targetOptions} onChange={(value) => onChange({ ...params, [targetKey]: value })} />
      </div>}
      {mode !== 'reset' && <>
        {numeric('intensity', '染色强度', mode === 'modulate' ? 1 : 0.8, '0', '1.5', '0', '1.5')}
        {numeric('brightness', '亮度', 0, '-1', '1', '-1', '1')}
        {numeric('warmth', '冷暖', 0, '-1', '1', '-1', '1')}
      </>}
      {!rowFieldKeys?.has(durationKey) && <div className="inspector-row">
        <span className="inspector-label">过渡时长</span>
        <InlineNumericInput ariaLabel="过渡时长" value={typeof params[durationKey] === 'number' ? params[durationKey] as number : mode === 'modulate' ? 1 : 0}
          step="0.1" min="0" popoverMin="0" popoverMax="5" onChange={(value, transient) => { if (!transient) onChange({ ...params, [durationKey]: value }); }} />
      </div>}
      {mode !== 'reset' && (
        <div className="inspector-row">
          <label className="inspector-label" htmlFor={`${id}-blend`}>颜色混合</label>
          <FormSelect id={`${id}-blend`} value={typeof values.colorBlendMode === 'string' ? values.colorBlendMode : 'multiply'} options={BLEND_MODE_OPTIONS} onChange={(value) => setValue('colorBlendMode', value)} />
        </div>
      )}
    </div>
  );
}
