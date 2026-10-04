import { useId, useMemo } from 'react';
import type { FormSelectOption } from '../FormSelect';
import { FormSelect } from '../FormSelect';

/** The value written into a post-processing statement for the full scene. */
export const PANORAMA_TARGET = 'panorama' as const;

export const LIGHTING_TARGET_GROUPS = {
  panorama: '全景',
  character: '角色',
  environmentLayer: '环境图层',
} as const;

export interface LightingTargetCharacter {
  readonly id: string;
  readonly name?: string;
}

export interface LightingTargetEnvironmentLayer {
  readonly layerId?: string;
  readonly id?: string;
  readonly value?: string;
  readonly displayLabel?: string;
  readonly label?: string;
  readonly name?: string;
  readonly isBackground?: boolean;
}

export interface LightingTargetPickerProps {
  /** The current semantic target. Missing targets stay selected as a disabled current-object option. */
  readonly value?: string | null;
  readonly onChange: (value: string) => void;
  readonly characters?: readonly (LightingTargetCharacter | string)[];
  readonly environmentLayers?: readonly (LightingTargetEnvironmentLayer | string)[];
  readonly label?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly dataTestId?: string;
  readonly className?: string;
}

export interface LightingTargetOption extends FormSelectOption {
  readonly targetKind?: 'panorama' | 'character' | 'environmentLayer' | 'current';
}

function readCharacter(character: LightingTargetCharacter | string): { id: string; name: string } | null {
  if (typeof character === 'string') {
    const id = character.trim();
    return id ? { id, name: id } : null;
  }

  const id = typeof character.id === 'string' ? character.id.trim() : '';
  if (!id) return null;
  const name = typeof character.name === 'string' && character.name.trim()
    ? character.name.trim()
    : id;
  return { id, name };
}

function readEnvironmentLayer(
  layer: LightingTargetEnvironmentLayer | string,
): { id: string; label: string; isBackground: boolean } | null {
  if (typeof layer === 'string') {
    const id = layer.trim();
    if (!id) return null;
    return { id, label: id === 'background' ? '背景' : id, isBackground: id === 'background' };
  }

  const id = [layer.layerId, layer.id, layer.value]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    ?.trim() ?? '';
  if (!id) return null;
  const isBackground = id === 'background' || layer.isBackground === true;
  const label = isBackground
    ? '背景'
    : [layer.displayLabel, layer.label, layer.name]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
      ?.trim() ?? id;
  return { id, label, isBackground };
}

/**
 * Build the options used by the lighting target picker.
 *
 * Keeping this model separate from the component makes the target contract
 * easy to reuse in authoring surfaces and, importantly, means an old target
 * is never silently replaced when the scene inventory no longer contains it.
 */
export function buildLightingTargetOptions(
  value: string | null | undefined,
  characters: readonly (LightingTargetCharacter | string)[] = [],
  environmentLayers: readonly (LightingTargetEnvironmentLayer | string)[] = [],
): readonly LightingTargetOption[] {
  const currentValue = typeof value === 'string' && value.trim() ? value : PANORAMA_TARGET;
  const options: LightingTargetOption[] = [];
  const knownValues = new Set<string>();

  const addOption = (option: LightingTargetOption) => {
    const optionValue = String(option.value);
    if (knownValues.has(optionValue)) return;
    knownValues.add(optionValue);
    options.push(option);
  };

  addOption({
    value: PANORAMA_TARGET,
    label: '全景',
    group: LIGHTING_TARGET_GROUPS.panorama,
    targetKind: 'panorama',
  });

  for (const character of characters) {
    const resolved = readCharacter(character);
    if (!resolved) continue;
    addOption({
      value: resolved.id,
      label: resolved.name === resolved.id ? resolved.id : `${resolved.name} (${resolved.id})`,
      group: LIGHTING_TARGET_GROUPS.character,
      targetKind: 'character',
    });
  }

  // The reserved background layer is always available, even in a scene that
  // has not authored its first environment statement yet.
  addOption({
    value: 'background',
    label: '背景',
    group: LIGHTING_TARGET_GROUPS.environmentLayer,
    targetKind: 'environmentLayer',
  });

  const resolvedLayers = environmentLayers
    .map(readEnvironmentLayer)
    .filter((layer): layer is { id: string; label: string; isBackground: boolean } => layer !== null);
  for (const layer of resolvedLayers) {
    addOption({
      value: layer.id,
      label: layer.label,
      group: LIGHTING_TARGET_GROUPS.environmentLayer,
      targetKind: 'environmentLayer',
    });
  }

  if (!knownValues.has(currentValue)) {
    addOption({
      value: currentValue,
      label: `当前对象 (${currentValue})`,
      title: `当前对象 (${currentValue})不可用，但会保留现有目标`,
      disabled: true,
      targetKind: 'current',
    });
  }

  return options;
}

/**
 * Authoring control for post-processing targets. It follows ActionInspector's
 * labelled inspector row and delegates menu behavior to the shared FormSelect
 * (including its keyboard and outside-pointer handling).
 */
export function LightingTargetPicker({
  value,
  onChange,
  characters = [],
  environmentLayers = [],
  label = '作用目标',
  id,
  disabled = false,
  dataTestId,
  className,
}: LightingTargetPickerProps) {
  const generatedId = useId();
  const controlId = id ?? `lighting-target-picker-${generatedId}`;
  const options = useMemo(
    () => buildLightingTargetOptions(value, characters, environmentLayers),
    [characters, environmentLayers, value],
  );
  const selectedValue = typeof value === 'string' && value.trim() ? value : PANORAMA_TARGET;

  return (
    <div className="inspector-row" data-testid={dataTestId ? `${dataTestId}-row` : undefined}>
      <label className="inspector-label" htmlFor={controlId}>{label}</label>
      <FormSelect
        id={controlId}
        value={selectedValue}
        options={options}
        onChange={onChange}
        disabled={disabled}
        className={className}
        aria-label={label}
        data-testid={dataTestId}
        title={options.find((option) => String(option.value) === selectedValue)?.title}
      />
    </div>
  );
}

// Naming aliases keep the control convenient for callers that describe the
// same semantic field as "post-processing" rather than "lighting".
export const PostProcessingTargetPicker = LightingTargetPicker;
export const LightingPostProcessingTargetPicker = LightingTargetPicker;
export const buildPostProcessingTargetOptions = buildLightingTargetOptions;

export default LightingTargetPicker;
