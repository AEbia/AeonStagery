import type { SceneMeta } from '../../api/types/scene-common';
import type { SceneVisualBlock } from '../../api/types/visual';
import type { SemanticTimelineReadModelItem } from './semanticTimelineReadModel';
import { InlineNumericInput } from './FormComponents';
import { getSemanticInspectorFields } from './semanticInspectorFieldCatalog';

const quickKeys = new Set([
  'id', 'target', 'layerId', 'speakerId', 'text', 'file', 'model', 'recipeId',
  'position', 'to', 'offset', 'screenTarget', 'scale', 'rotation', 'opacity',
  'zoom', 'intensity', 'durationSeconds', 'volume', 'fadeOut', 'motion', 'expression',
]);
const coordinateKeys = new Set(['position', 'to', 'offset', 'screenTarget']);

export type QuickParamPatch = Record<string, unknown> | ((params: Record<string, unknown>) => Record<string, unknown>);

export function StatementQuickControls({ item, sceneMeta, sceneVisual, disabled, onChange }: {
  item: SemanticTimelineReadModelItem;
  sceneMeta: SceneMeta;
  sceneVisual?: SceneVisualBlock;
  disabled: boolean;
  onChange: (patch: QuickParamPatch) => void;
}) {
  const source = item.source.params as Record<string, unknown>;
  const fields = getSemanticInspectorFields(item.source.type, source, sceneVisual)
    .filter((field) => quickKeys.has(field.key));
  const isDialogue = item.source.type === 'dialogue';
  const characters = sceneMeta.characters ?? [];

  return (
    <fieldset className="timeline-item__quick-fields" disabled={disabled} aria-label="基本属性">
      {fields.map((field) => {
        const value = source[field.key] === undefined ? field.defaultValue?.(source, sceneVisual) : source[field.key];
        const characterField = field.key === 'speakerId'
          || (field.key === 'id' && ['characterPresence', 'characterTransform'].includes(item.source.type))
          || (field.key === 'target' && ['characterPerformance', 'camera'].includes(item.source.type));
        if (characterField) {
          const current = typeof value === 'string' ? value : '';
          const label = isDialogue ? '选择说话角色' : item.source.type === 'camera' ? '跟随目标' : '选择角色';
          return (
            <label key={field.key} className="timeline-item__inline-field">
              {!isDialogue && <span className="timeline-item__inline-label">{field.label}</span>}
              <select className="timeline-item__inline-select" value={current} aria-label={label}
                onChange={(event) => {
                  const id = event.target.value;
                  if (!isDialogue) { onChange({ [field.key]: id }); return; }
                  const character = characters.find((candidate) => candidate.id === id);
                  onChange({ speakerId: id || undefined, speaker: character?.name, speakerColor: character?.color });
                }}>
                <option value="">{isDialogue ? '(旁白)' : '选择角色...'}</option>
                {current && !characters.some((character) => character.id === current) && <option value={current}>{current}</option>}
                {characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
              </select>
            </label>
          );
        }
        if (coordinateKeys.has(field.key)) {
          const position = Array.isArray(value) ? value : field.key === 'offset' ? [0, 0] : [0.5, 0.5];
          return [0, 1].map((axis) => (
            <div key={`${field.key}:${axis}`} className="timeline-item__inline-field">
              <InlineNumericInput dragLabel={axis === 0 ? 'X' : 'Y'}
                ariaLabel={`${field.label} ${axis === 0 ? 'X' : 'Y'}`}
                className="timeline-item__numeric-control" value={position[axis]} step="0.01"
                inferNormalizedBounds={false} popoverMin={field.key === 'offset' ? '-1' : '0'} popoverMax="1"
                disabled={disabled} onChange={(number, transient) => {
                  if (transient || !Number.isFinite(number)) return;
                  onChange((current) => {
                    const next = [...(Array.isArray(current[field.key]) ? current[field.key] as number[] : position)];
                    next[axis] = number;
                    return { [field.key]: next };
                  });
                }} />
            </div>
          ));
        }
        if (field.key === 'text') {
          return <textarea key={field.key} rows={2} className="timeline-item__inline-input timeline-item__inline-input--text"
            value={typeof value === 'string' ? value : ''} aria-label={isDialogue ? '编辑台词内容' : field.label}
            placeholder={isDialogue ? '输入台词内容...' : field.label}
            onChange={(event) => onChange({ text: event.target.value })} />;
        }
        if (field.key === 'zoom') {
          const zoom = value && typeof value === 'object' ? value as { kind: string; value: number } : undefined;
          return (
            <div key={field.key} className="timeline-item__inline-field">
              <InlineNumericInput dragLabel={zoom?.kind === 'delta' ? '变焦增量' : field.label}
                ariaLabel={field.label} className="timeline-item__numeric-control" disabled={disabled}
                value={zoom?.value ?? 1} step={field.step ?? '0.05'} min={zoom?.kind === 'delta' ? undefined : field.min}
                popoverMin={field.popoverMin} popoverMax={field.popoverMax}
                onChange={(number, transient) => {
                  if (!transient && Number.isFinite(number)) onChange({ zoom: { kind: zoom?.kind ?? 'absolute', value: number } });
                }} />
            </div>
          );
        }
        if (field.key === 'motion') {
          const motion = value && typeof value === 'object' ? value as { kind: string; key: string } : undefined;
          return (
            <label key={field.key} className="timeline-item__inline-field">
              <span className="timeline-item__inline-label">动作</span>
              <input className="timeline-item__inline-input" aria-label="动作名称" readOnly={motion?.kind === 'custom'}
                title={motion?.kind === 'custom' ? '展开详情编辑自定义动作' : undefined}
                value={motion?.kind === 'custom' ? '自定义动作' : motion?.key ?? ''}
                onChange={(event) => onChange({ motion: event.target.value ? { ...motion, kind: 'resource', key: event.target.value } : '' })} />
            </label>
          );
        }
        if (value !== undefined && typeof value !== 'string' && typeof value !== 'number') return null;
        const numeric = field.valueType === 'number';
        const label = item.source.type === 'camera' && source.mode === 'shake'
          ? field.key === 'intensity' ? '震动强度' : field.key === 'durationSeconds' ? '震动时长' : field.label
          : field.label;
        if (numeric) return (
          <div key={field.key} className="timeline-item__inline-field">
            <InlineNumericInput dragLabel={field.label} ariaLabel={label} disabled={disabled}
              className="timeline-item__numeric-control" value={typeof value === 'number' ? value : ['scale', 'opacity', 'volume'].includes(field.key) ? 1 : 0}
              min={field.min} max={field.max} step={field.step} popoverMin={field.popoverMin} popoverMax={field.popoverMax}
              onChange={(number, transient) => {
                if (!transient && Number.isFinite(number)) onChange({ [field.key]: number });
              }} />
          </div>
        );
        return (
          <label key={field.key} className="timeline-item__inline-field">
            <span className="timeline-item__inline-label">{field.label}</span>
            <input type="text" min={field.min} max={field.max} step={field.step}
              className="timeline-item__inline-input"
              value={value ?? ''} aria-label={label}
              onChange={(event) => {
                onChange({ [field.key]: event.target.value });
              }} />
          </label>
        );
      })}
    </fieldset>
  );
}
