import { useId, useMemo } from 'react';
import type { FormSelectOption } from '../FormSelect';
import { FormSelect } from '../FormSelect';
import { type LightingTarget, lightingTargetKey } from '../../api/types/lighting-target';

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
  readonly authoredLabel?: string;
  readonly sourceFile?: string;
  readonly label?: string;
  readonly name?: string;
  readonly isBackground?: boolean;
}

export interface LightingTargetPickerProps {
  /** The current semantic target. Missing targets stay selected as a disabled current-object option. */
  readonly value?: LightingTarget | null;
  readonly onChange: (value: LightingTarget) => void;
  readonly characters?: readonly (LightingTargetCharacter | string)[];
  readonly environmentLayers?: readonly (LightingTargetEnvironmentLayer | string)[];
  readonly label?: string;
  readonly id?: string;
  readonly disabled?: boolean;
  readonly dataTestId?: string;
  readonly className?: string;
  readonly effect?: 'post' | 'blur';
}

export interface LightingTargetOption extends FormSelectOption {
  readonly target: LightingTarget;
  readonly targetKind?: 'panorama' | 'character' | 'environmentLayer' | 'current';
}

function selectedTarget(value: LightingTarget | null | undefined, effect: 'blur' | 'post'): LightingTarget {
  return value == null || (typeof value === 'string' && !value.trim())
    ? effect === 'blur' ? 'global' : PANORAMA_TARGET : value;
}

function selectionKey(target: LightingTarget): string {
  return JSON.stringify(target);
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
): { id: string; label: string; title?: string } | null {
  if (typeof layer === 'string') {
    const id = layer.trim();
    if (!id) return null;
    return { id, label: id };
  }

  const id = [layer.layerId, layer.id, layer.value]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    ?.trim() ?? '';
  if (!id) return null;
  return {
    id,
    label: id,
    title: layer.sourceFile,
  };
}

/**
 * Build the options used by the lighting target picker.
 *
 * Keeping this model separate from the component makes the target contract
 * easy to reuse in authoring surfaces and, importantly, means an old target
 * is never silently replaced when the scene inventory no longer contains it.
 */
export function buildLightingTargetOptions(
  value: LightingTarget | null | undefined,
  characters: readonly (LightingTargetCharacter | string)[] = [],
  environmentLayers: readonly (LightingTargetEnvironmentLayer | string)[] = [],
  effect: 'post' | 'blur' = 'post',
): readonly LightingTargetOption[] {
  const sceneTarget = effect === 'blur' ? 'global' : PANORAMA_TARGET;
  const currentTarget = selectedTarget(value, effect);
  const resolvedCharacters = characters.map(readCharacter).filter((character) => character !== null);
  const resolvedLayers = environmentLayers.map(readEnvironmentLayer).filter((layer) => layer !== null);
  const characterIds = new Set(resolvedCharacters.map((character) => character.id));
  const currentIdentity = lightingTargetKey(currentTarget, effect, characterIds);
  const options: LightingTargetOption[] = [];
  const addOption = (target: LightingTarget, option: Omit<LightingTargetOption, 'value' | 'target'>) => {
    // Keep legacy spelling until the author actually selects a different object.
    const sourceTarget = lightingTargetKey(target, effect, characterIds) === currentIdentity ? currentTarget : target;
    options.push({ ...option, target: sourceTarget, value: selectionKey(sourceTarget) });
  };
  addOption(sceneTarget, { label: '全景', group: LIGHTING_TARGET_GROUPS.panorama, targetKind: 'panorama' });
  addOption({ kind: 'group', group: 'characters' }, { label: '全部角色', group: LIGHTING_TARGET_GROUPS.character });
  for (const character of resolvedCharacters) {
    addOption({ kind: 'character', id: character.id }, {
      label: character.name, group: LIGHTING_TARGET_GROUPS.character, targetKind: 'character',
    });
  }
  addOption({ kind: 'group', group: 'environmentLayers' }, { label: '全部环境图层', group: LIGHTING_TARGET_GROUPS.environmentLayer });
  const addLayer = (id: string, title?: string) => addOption({ kind: 'environmentLayer', id }, {
    label: id, title, group: LIGHTING_TARGET_GROUPS.environmentLayer, targetKind: 'environmentLayer',
  });
  addLayer('background', resolvedLayers.find((layer) => layer.id === 'background')?.title);
  for (const layer of resolvedLayers) if (layer.id !== 'background') addLayer(layer.id, layer.title);
  if (!options.some((option) => option.value === selectionKey(currentTarget))) {
    const label = typeof currentTarget === 'string' ? currentTarget : 'id' in currentTarget ? currentTarget.id : '未知目标';
    addOption(currentTarget, {
      label: `当前对象 (${label})`, title: `当前对象 (${label})不可用，但会保留现有目标`,
      disabled: true, targetKind: 'current',
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
  effect = 'post',
}: LightingTargetPickerProps) {
  const generatedId = useId();
  const controlId = id ?? `lighting-target-picker-${generatedId}`;
  const options = useMemo(
    () => buildLightingTargetOptions(value, characters, environmentLayers, effect),
    [characters, environmentLayers, value, effect],
  );
  const selectedValue = selectionKey(selectedTarget(value, effect));

  return (
    <div className="inspector-row" data-testid={dataTestId ? `${dataTestId}-row` : undefined}>
      <label className="inspector-label" htmlFor={controlId}>{label}</label>
      <FormSelect
        id={controlId}
        value={selectedValue}
        options={options}
        onChange={(key) => {
          const option = options.find((candidate) => candidate.value === key);
          if (option) onChange(option.target);
        }}
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
