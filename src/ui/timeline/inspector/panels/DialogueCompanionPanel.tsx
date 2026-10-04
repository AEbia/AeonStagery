// Dialogue companion editor: list, reorder, per-family param rows and the
// add-companion draft row (was renderDialogueCompanionPanel + authorCompanion).
import React from 'react';
import {
  FileInput,
  InlineNumericInput,
} from '../../FormComponents';
import { FormSelect } from '../../../FormSelect';
import { ColorPickerInput } from '../../../ColorPickerInput';
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash } from '../../../icons';
import { CharacterIntegrationControls } from '../../CharacterIntegrationControls';
import { BLEND_MODE_OPTIONS } from '../../blendModeOptions';
import { getRecipeDisplayLabel } from '../../visualPresentation';
import { AUTHORING_SCHEMA_VERSION } from '../../../../api/types/authoring';
import type { DialogueCompanion, SceneStatement } from '../../../../api/types/semantic-scene';
import { createSemanticTimelineCorrelationId } from '../../semanticTimelineEditing';
import {
  getSemanticInspectorFields,
  materializeSemanticInspectorParams,
} from '../../semanticInspectorFieldCatalog';
import type { SemanticTimelineReadModelItem } from '../../semanticTimelineReadModel';
import type { TimelineScene } from '../../semanticTimelineTypes';
import {
  dialogueCompanionDefinitions,
  dialogueCompanionNeedsCharacterTarget,
  createDialogueCompanionDraft,
  characterPerformanceMotionKey,
  type DialogueCompanionFamily,
} from '../dialogueCompanionModel';
import { asRecord } from '../asRecord';
import {
  getVisualStyleOverrideConfig,
  getVisualStyleOverrideLabel,
  getVisualStyleSemanticLabel,
  listVisualRecipeIds,
  VISUAL_STYLE_OVERRIDE_KEYS,
} from '../visualStyleLabels';
import type { SemanticAuthoringApplicationService } from '../../../../services/timeline-authoring/SemanticAuthoringApplicationService';
import type { ActionInspectorProps } from '../../ActionInspector';

type CharacterMeta = NonNullable<TimelineScene['meta']['characters']>[number];

export interface DialogueCompanionPanelProps {
  semanticItem: SemanticTimelineReadModelItem | undefined;
  sceneData: TimelineScene;
  semanticTimelineItems: Array<{ statementId: string; companionId?: string; displayAction: { _id?: string } }>;
  dialogueSpeakerCharacter: CharacterMeta | undefined;
  semanticAuthoring: SemanticAuthoringApplicationService | undefined;
  setSelectedIds: ActionInspectorProps['setSelectedIds'];
  visualTargetOptions: Array<{ value: string; label: string }>;
  characterVisualTargetOptions: Array<{ value: string; label: string }>;
}

export function DialogueCompanionPanel(props: DialogueCompanionPanelProps) {
  const {
    semanticItem, sceneData, semanticTimelineItems, dialogueSpeakerCharacter, semanticAuthoring,
    setSelectedIds, visualTargetOptions, characterVisualTargetOptions,
  } = props;

  const [newCompanionKind, setNewCompanionKind] = React.useState<DialogueCompanionFamily>('camera');
  const [newCompanionTargets, setNewCompanionTargets] = React.useState<Record<string, string>>({});

  const authorCompanion = async (intent: Parameters<NonNullable<SemanticAuthoringApplicationService>['author']>[0]) => {
    if (!semanticAuthoring) return;
    await semanticAuthoring.author(intent);
  };

  if (!semanticItem || semanticItem.locator.kind !== 'statement' || semanticItem.source.type !== 'dialogue') return null;
  const parent = semanticItem.source as Extract<SceneStatement, { type: 'dialogue' }>;
  const companions = parent.companions ?? [];
  const hasParentSpeaker = typeof parent.params.speakerId === 'string' && parent.params.speakerId.length > 0;
  const speakerTargetOptions = hasParentSpeaker
    ? [{ value: '$speaker', label: dialogueSpeakerCharacter ? `${dialogueSpeakerCharacter.name}（当前说话人）` : '当前说话人' }]
    : [];
  const companionCharacterOptions = (sceneData.meta.characters ?? []).map((character) => ({
    value: character.id,
    label: `${character.name || character.id}（ID: ${character.id}）`,
  }));
  const newCompanionTarget = newCompanionTargets[parent.id] ?? '';
  const newCompanionDraft = createDialogueCompanionDraft(
    newCompanionKind,
    parent.params.speakerId,
    newCompanionTarget || undefined,
  );
  const updateCompanion = (companion: DialogueCompanion, patch: Partial<DialogueCompanion>) => {
    void authorCompanion({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: createSemanticTimelineCorrelationId('dialogue_companion_update'),
      origin: 'timeline-editor',
      kind: 'update-dialogue-companion',
      locator: { statementId: parent.id, companionId: companion.id },
      patch,
    });
  };
  const updateCompanionParam = (companion: DialogueCompanion, key: string, value: unknown) => {
    updateCompanion(companion, { params: { ...companion.params, [key]: value } } as Partial<DialogueCompanion>);
  };
  const reorder = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= companions.length) return;
    const ids = companions.map((companion) => companion.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void authorCompanion({
      version: AUTHORING_SCHEMA_VERSION,
      correlationId: createSemanticTimelineCorrelationId('dialogue_companion_reorder'),
      origin: 'timeline-editor',
      kind: 'reorder-dialogue-companions',
      parentStatementId: parent.id,
      orderedCompanionIds: ids,
    });
  };
  const renderVisualStyleCompanion = (companion: DialogueCompanion) => {
    const params = materializeSemanticInspectorParams('visualStyle', companion.params as Record<string, unknown>, sceneData.visual);
    const slot = String(params.slot || 'integration');
    if (slot === 'integration') {
      return <CharacterIntegrationControls params={companion.params as Record<string, unknown>} sceneVisual={sceneData.visual}
        mode={params.mode as 'set' | 'modulate' | 'reset'}
        targets={[...speakerTargetOptions, ...characterVisualTargetOptions]}
        onChange={(next) => updateCompanion(companion, { params: next } as Partial<DialogueCompanion>)} />;
    }
    const fields = getSemanticInspectorFields('visualStyle', params, sceneData.visual)
      .filter((fieldDefinition) => !['scope', 'target', 'slot', 'mode'].includes(fieldDefinition.key))
      .filter((fieldDefinition) => fieldDefinition.visibility === 'authoring');
    const visualOverride = asRecord(params.semanticOverride);
    const updateOverride = (key: string, value: unknown) => {
      const nextOverride = { ...visualOverride, [key]: value };
      updateCompanionParam(companion, 'semanticOverride', nextOverride);
    };
    const targetOptions = [
      ...speakerTargetOptions,
      ...visualTargetOptions.map((option) => ({ value: option.value, label: option.label })),
    ].filter((option, index, options) => options.findIndex((candidate) => candidate.value === option.value) === index);
    return (
      <>
        <div className="inspector-row">
          <span className="inspector-label">作者语义</span>
          <span className="inspector-value">{getVisualStyleSemanticLabel(params)}</span>
        </div>
        <div className="inspector-row">
          <label className="inspector-label" htmlFor={`companion-${companion.id}-target`}>目标对象</label>
          <FormSelect id={`companion-${companion.id}-target`} value={typeof params.target === 'string' ? params.target : '$speaker'} options={targetOptions} onChange={(value) => updateCompanionParam(companion, 'target', value)} />
        </div>
        {fields.map((fieldDefinition) => {
          const key = fieldDefinition.key;
          const value = params[key];
          if (key === 'recipeId') {
            const recipeOptions = listVisualRecipeIds(sceneData.visual, 'object', slot).map((recipeId) => ({ value: recipeId, label: getRecipeDisplayLabel(sceneData.visual, recipeId) }));
            if (recipeOptions.length === 0) return null;
            return <div className="inspector-row" key={key}><label className="inspector-label" htmlFor={`companion-${companion.id}-${key}`}>{fieldDefinition.label}</label><FormSelect id={`companion-${companion.id}-${key}`} value={typeof value === 'string' ? value : recipeOptions[0].value} options={recipeOptions} onChange={(nextValue) => updateCompanionParam(companion, key, nextValue)} /></div>;
          }
          if (key === 'semanticOverride') {
            const overrideKeys = VISUAL_STYLE_OVERRIDE_KEYS[slot] ?? [];
            return (
              <div className="inspector-row stacked" key={key} data-testid={`companion-${companion.id}-visual-override`}>
                <span className="inspector-label">风格微调</span>
                <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                  {overrideKeys.map((overrideKey) => {
                    const overrideLabel = getVisualStyleOverrideLabel(slot, overrideKey);
                    const overrideValue = visualOverride[overrideKey];
                    if (overrideKey === 'colorStops') {
                      const stops = Array.isArray(overrideValue) ? overrideValue : [];
                      return (
                        <div className="inspector-row" key={overrideKey}>
                          <span className="inspector-label">{overrideLabel}</span>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, minWidth: 0 }}>
                            {['左上', '右上', '左下', '右下'].map((stopLabel, index) => {
                              const stop = String(stops[index] || '#ffffff');
                              const colorValue = /^#[0-9a-f]{6}$/i.test(stop) ? stop : '#ffffff';
                              const updateStop = (nextValue: string) => {
                                const nextStops = [...stops];
                                nextStops[index] = nextValue;
                                updateOverride(overrideKey, nextStops);
                              };
                              return (
                                <div className="compound-input" key={stopLabel} style={{ height: '26px', padding: '1px 1px' }}>
                                  <span style={{ width: 24, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>{stopLabel}</span>
                                  <ColorPickerInput aria-label={`伴随语句${stopLabel}色标选择器`} style={{ width: 22, height: 22, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent', borderRadius: 'var(--radius-sm)' }} value={colorValue} onChange={(color) => updateStop(color)} />
                                  <input type="text" aria-label={`伴随语句${stopLabel}色标`} style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '0 4px', fontSize: 10, color: 'var(--text-primary)', outline: 'none' }} value={stop} onChange={(event) => updateStop(event.target.value)} />
                                </div>
                              );
                            })}
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
                            <ColorPickerInput aria-label={`伴随语句${overrideLabel}选择器`} style={{ width: 22, height: 22, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent', borderRadius: 'var(--radius-sm)' }} value={/^#[0-9a-f]{6}$/i.test(colorValue) ? colorValue : '#ffffff'} onChange={(color) => updateOverride(overrideKey, color)} />
                            <input type="text" aria-label={`伴随语句${overrideLabel}`} style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '0 6px', fontSize: 11, color: 'var(--text-primary)', outline: 'none' }} value={colorValue} onChange={(event) => updateOverride(overrideKey, event.target.value)} />
                          </div>
                        </div>
                      );
                    }
                    if (overrideKey === 'colorBlendMode') {
                      return (
                        <div className="inspector-row" key={overrideKey}>
                          <label className="inspector-label" htmlFor={`companion-${companion.id}-semantic-override-${overrideKey}`}>{overrideLabel}</label>
                          <FormSelect id={`companion-${companion.id}-semantic-override-${overrideKey}`} value={typeof overrideValue === 'string' ? overrideValue : 'multiply'} options={BLEND_MODE_OPTIONS} onChange={(value) => updateOverride(overrideKey, value)} />
                        </div>
                      );
                    }
                    const overrideConfig = getVisualStyleOverrideConfig(overrideKey);
                    return (
                      <div className="inspector-row" key={overrideKey}>
                        <span className="inspector-label">{overrideLabel}</span>
                        <InlineNumericInput
                          ariaLabel={`伴随语句${overrideLabel}`}
                          dragLabel="值"
                          step={overrideConfig.step ?? "0.05"}
                          min={overrideConfig.min}
                          max={overrideConfig.max}
                          popoverMin={overrideConfig.popoverMin}
                          popoverMax={overrideConfig.popoverMax}
                          value={typeof overrideValue === 'number' ? overrideValue : 0}
                          onChange={(nextValue, isTransient) => {
                            if (!isTransient) updateOverride(overrideKey, nextValue);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }
          if (key === 'colorStops') {
            const stops = Array.isArray(value) ? value : [];
            return (
              <div className="inspector-row" key={key}>
                <span className="inspector-label">{fieldDefinition.label}</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, minWidth: 0 }}>
                  {['左上', '右上', '左下', '右下'].map((stopLabel, index) => {
                    const stop = String(stops[index] || '#ffffff');
                    const colorValue = /^#[0-9a-f]{6}$/i.test(stop) ? stop : '#ffffff';
                    const updateStop = (nextValue: string) => {
                      const nextStops = [...stops];
                      nextStops[index] = nextValue;
                      updateCompanionParam(companion, key, nextStops);
                    };
                    return (
                      <div className="compound-input" key={stopLabel} style={{ height: '26px', padding: '1px 1px' }}>
                        <span style={{ width: 24, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>{stopLabel}</span>
                        <ColorPickerInput aria-label={`伴随语句${stopLabel}色标选择器`} style={{ width: 22, height: 22, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent', borderRadius: 'var(--radius-sm)' }} value={colorValue} onChange={(color) => updateStop(color)} />
                        <input type="text" aria-label={`伴随语句${stopLabel}色标`} style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '0 4px', fontSize: 10, color: 'var(--text-primary)', outline: 'none' }} value={stop} onChange={(event) => updateStop(event.target.value)} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          }
          if (key === 'color') {
            const colorValue = typeof value === 'string' ? value : '#ffffff';
            return <div className="inspector-row" key={key}><span className="inspector-label">{fieldDefinition.label}</span><div className="compound-input" style={{ height: '26px', padding: '1px 1px' }}><ColorPickerInput aria-label={`伴随语句${fieldDefinition.label}选择器`} style={{ width: 22, height: 22, padding: 0, border: 'none', cursor: 'pointer', background: 'transparent', borderRadius: 'var(--radius-sm)' }} value={/^#[0-9a-f]{6}$/i.test(colorValue) ? colorValue : '#ffffff'} onChange={(color) => updateCompanionParam(companion, key, color)} /><input type="text" aria-label={`伴随语句${fieldDefinition.label}`} style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', padding: '0 6px', fontSize: 11, color: 'var(--text-primary)', outline: 'none' }} value={colorValue} onChange={(event) => updateCompanionParam(companion, key, event.target.value)} /></div></div>;
          }
          if (fieldDefinition.valueType === 'number' || typeof value === 'number') {
            return (
              <div className="inspector-row" key={key}>
                <span className="inspector-label">{fieldDefinition.label}</span>
                <InlineNumericInput
                  ariaLabel={`伴随语句${fieldDefinition.label}`}
                  dragLabel="值"
                  step={fieldDefinition.step ?? "0.05"}
                  min={fieldDefinition.min}
                  max={fieldDefinition.max}
                  popoverMin={fieldDefinition.popoverMin}
                  popoverMax={fieldDefinition.popoverMax}
                  value={typeof value === 'number' ? value : 0}
                  onChange={(nextValue, isTransient) => { if (!isTransient) updateCompanionParam(companion, key, nextValue); }}
                />
              </div>
            );
          }
          if (key === 'colorBlendMode') {
            return <div className="inspector-row" key={key}><label className="inspector-label" htmlFor={`companion-${companion.id}-${key}`}>{fieldDefinition.label}</label><FormSelect id={`companion-${companion.id}-${key}`} value={typeof value === 'string' ? value : 'multiply'} options={BLEND_MODE_OPTIONS} onChange={(nextValue) => updateCompanionParam(companion, key, nextValue)} /></div>;
          }
          return null;
        })}
      </>
    );
  };
  return (
    <div
      className="inspector-section dialogue-companion-editor"
      data-testid="dialogue-companion-editor"
      data-has-companions={companions.length > 0}
    >
      <div className="inspector-section-title">伴随语句</div>
      <div className="dialogue-companion-list" role="list">
        {companions.map((companion, index) => {
          const companionItem = semanticTimelineItems.find((item) => (
            item.statementId === parent.id && item.companionId === companion.id
          ));
          const companionActionId = companionItem?.displayAction._id;
          const companionLabel = dialogueCompanionDefinitions.find((definition) => definition.family === companion.type)?.label
            ?? companion.type;

          return (
        <div className="dialogue-companion-item" key={companion.id} role="listitem">
          <div className="inspector-inline-control-row" style={{ marginBottom: 8 }}>
            <FormSelect
              aria-label="伴随语句类型"
              value={companion.type}
              options={dialogueCompanionDefinitions.map((definition) => {
                const currentTarget = 'target' in companion.params ? companion.params.target : undefined;
                const canReuseTarget = typeof currentTarget === 'string' && currentTarget.length > 0 && currentTarget !== '$speaker';
                const disabled = !hasParentSpeaker && dialogueCompanionNeedsCharacterTarget(definition.family) && !canReuseTarget;
                return {
                  value: definition.family,
                  label: definition.label,
                  disabled,
                  ...(disabled ? { title: '请先设置对白说话人，或提供明确的角色目标' } : {}),
                };
              })}
              onChange={(value) => {
                const currentTarget = 'target' in companion.params ? companion.params.target : undefined;
                const replacement = createDialogueCompanionDraft(
                  value as DialogueCompanionFamily,
                  parent.params.speakerId,
                  currentTarget === '$speaker' ? undefined : currentTarget,
                );
                if (!replacement) return;
                updateCompanion(companion, { type: replacement.type, params: replacement.params } as Partial<DialogueCompanion>);
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn--sm"
              aria-label={`选中${companionLabel}伴随语句`}
              title={`在时间轴中选中${companionLabel}伴随语句`}
              disabled={!companionActionId}
              onClick={() => {
                if (companionActionId) setSelectedIds({ [companionActionId]: true });
              }}
            >
              选中
            </button>
            <button className="btn btn--icon" title="上移" aria-label="上移伴随语句" disabled={index === 0} onClick={() => reorder(index, -1)}><IconChevronUp width={13} height={13} /></button>
            <button className="btn btn--icon" title="下移" aria-label="下移伴随语句" disabled={index === companions.length - 1} onClick={() => reorder(index, 1)}><IconChevronDown width={13} height={13} /></button>
            <button className="btn btn--icon" title="删除伴随语句" aria-label="删除伴随语句" onClick={() => { void authorCompanion({ version: AUTHORING_SCHEMA_VERSION, correlationId: createSemanticTimelineCorrelationId('dialogue_companion_delete'), origin: 'timeline-editor', kind: 'delete-dialogue-companions', locators: [{ statementId: parent.id, companionId: companion.id }] }); }}><IconTrash width={13} height={13} /></button>
          </div>
          <div className="inspector-row"><label className="inspector-label" htmlFor={`companion-${companion.id}-anchor`}>锚点</label><FormSelect id={`companion-${companion.id}-anchor`} value={companion.anchor} options={[{ value: 'start', label: '对白开始' }, { value: 'end', label: '对白结束' }]} onChange={(value) => updateCompanion(companion, { anchor: value as 'start' | 'end' })} /></div>
          <div className="inspector-row"><span className="inspector-label">偏移</span><InlineNumericInput ariaLabel="伴随语句偏移秒数" dragLabel="秒" step="0.1" popoverMin="-5" popoverMax="5" value={companion.offset} onChange={(value, isTransient) => { if (!isTransient) updateCompanion(companion, { offset: value }); }} /></div>
          {((companion.type === 'camera' && companion.params.mode === 'focus') || companion.type === 'characterPerformance') && (
            <div className="inspector-row">
              <label className="inspector-label" htmlFor={`companion-${companion.id}-target`}>目标</label>
              <FormSelect
                id={`companion-${companion.id}-target`}
                placeholder="请选择目标"
                value={('target' in companion.params ? companion.params.target : undefined) || ''}
                options={[
                  ...speakerTargetOptions,
                  ...companionCharacterOptions,
                ]}
                onChange={(value) => updateCompanionParam(companion, 'target', value)}
              />
            </div>
          )}
          {companion.type === 'camera' && companion.params.mode === 'focus' && (
            <div className="inspector-row"><span className="inspector-label">变焦增量</span><InlineNumericInput ariaLabel="变焦增量" dragLabel="值" step="0.05" popoverMin="-1" popoverMax="1" value={companion.params.zoom?.value ?? 0.15} onChange={(value, isTransient) => { if (!isTransient) updateCompanionParam(companion, 'zoom', { kind: 'delta', value }); }} /></div>
          )}
          {companion.type === 'characterPerformance' && (
            <>
              <div className="inspector-row">
                <label className="inspector-label" htmlFor={`companion-${companion.id}-motion`}>动作</label>
                <input
                  id={`companion-${companion.id}-motion`}
                  className="form-input"
                  placeholder="输入动作名称..."
                  value={characterPerformanceMotionKey(companion.params.motion) || ''}
                  onChange={(event) => updateCompanionParam(companion, 'motion', event.target.value ? { kind: 'resource', key: event.target.value } : undefined)}
                />
              </div>
              <div className="inspector-row">
                <label className="inspector-label" htmlFor={`companion-${companion.id}-expression`}>表情</label>
                <input
                  id={`companion-${companion.id}-expression`}
                  className="form-input"
                  placeholder="输入表情名称..."
                  value={companion.params.expression || ''}
                  onChange={(event) => updateCompanionParam(companion, 'expression', event.target.value || undefined)}
                />
              </div>
            </>
          )}
          {companion.type === 'visualStyle' && renderVisualStyleCompanion(companion)}
          {companion.type === 'audio' && companion.params.role === 'sfx' && companion.params.mode === 'play' && (
            <><FileInput label="音效文件" value={companion.params.file || ''} onChange={(value) => updateCompanionParam(companion, 'file', value)} filters={[{ name: '音频', extensions: ['mp3', 'wav', 'ogg'] }]} importKind="generic" initialDir="sfx" placeholder="选择音效文件..." /><div className="inspector-row"><span className="inspector-label">音量</span><InlineNumericInput ariaLabel="伴随音效音量" dragLabel="值" step="0.05" min="0" max="1" value={companion.params.volume ?? 1} onChange={(value, isTransient) => { if (!isTransient) updateCompanionParam(companion, 'volume', value); }} /></div></>
          )}
        </div>
          );
        })}
      </div>
      {!hasParentSpeaker && dialogueCompanionNeedsCharacterTarget(newCompanionKind) && (
        <div className="inspector-row" style={{ marginTop: 8 }}>
          <label className="inspector-label" htmlFor={`new-companion-target-${parent.id}`}>目标角色</label>
          <FormSelect
            id={`new-companion-target-${parent.id}`}
            aria-label="新伴随语句目标角色"
            placeholder={companionCharacterOptions.length > 0 ? '请选择角色' : '场景中没有可选角色'}
            value={newCompanionTarget}
            options={companionCharacterOptions}
            disabled={companionCharacterOptions.length === 0}
            onChange={(value) => setNewCompanionTargets((current) => ({ ...current, [parent.id]: value }))}
          />
        </div>
      )}
      <div className="inspector-inline-control-row" style={{ marginTop: 10 }}>
        <FormSelect value={newCompanionKind} options={dialogueCompanionDefinitions.map((definition) => ({ value: definition.family, label: definition.label }))} onChange={(value) => setNewCompanionKind(value as DialogueCompanionFamily)} />
        <button
          className="btn btn--icon"
          title={newCompanionDraft ? '添加伴随语句' : '请选择伴随语句的目标角色'}
          aria-label="添加伴随语句"
          disabled={!newCompanionDraft}
          onClick={() => {
            if (!newCompanionDraft) return;
            void authorCompanion({ version: AUTHORING_SCHEMA_VERSION, correlationId: createSemanticTimelineCorrelationId('dialogue_companion_insert'), origin: 'timeline-editor', kind: 'insert-dialogue-companion', parentStatementId: parent.id, companion: newCompanionDraft });
          }}
        ><IconPlus width={14} height={14} /></button>
      </div>
    </div>
  );
}
