import { memo, useMemo, useRef } from 'react';
import { useTimelineTextareaSize } from './useTimelineTextareaSize';
import type { SemanticTimelineReadModelItem } from './semanticTimelineReadModel';
import type { TimelineAction, TimelineScene } from './semanticTimelineTypes';
import { useCharacterAdapter } from '../context/AppContext';
import { CollaborativeDraftNotice, InlineNumericInput, useRemoteAwareStringDraft } from './FormComponents';
import { getStatementQuickFields, quickCoordinateKeys } from './statementQuickFields';
import { FormSelect } from '../FormSelect';
import { InlineFilePicker } from '../InlineFilePicker';
import { buildCharacterEntranceModelOptions, resolveActiveModelPath } from './inspector/entranceModelOptions';
import { resolveCharacterPerformanceTargetCharId } from './characterPerformancePresentation';
import { Live2DResourceSelect } from './inspector/Live2DResourceSelect';
import { useCharacterModelData } from './inspector/useModelData';
import { characterPerformanceMotionKey } from './inspector/dialogueCompanionModel';

export type QuickParamPatch = Record<string, unknown> | ((params: Record<string, unknown>) => Record<string, unknown>);

function QuickTextInput({ value, label, multiline = false, expanded = false, readOnly = false, title, disabled, onChange }: {
  value: string;
  label: string;
  multiline?: boolean;
  expanded?: boolean;
  readOnly?: boolean;
  title?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const draft = useRemoteAwareStringDraft(value, onChange);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useTimelineTextareaSize(textareaRef, expanded, draft.localValue);
  const inputProps = {
    value: draft.localValue,
    'aria-label': label,
    disabled,
    readOnly,
    title,
    onFocus: draft.beginEditing,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => draft.setLocalValue(event.target.value),
    onBlur: () => { if (disabled || readOnly) draft.cancelEditing(); else draft.commitEditing(); },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        draft.cancelEditing();
        event.currentTarget.blur();
      } else if (event.key === 'Enter' && !multiline && !event.nativeEvent.isComposing) {
        event.currentTarget.blur();
      }
    },
  };
  return <>
    {multiline
      ? <textarea {...inputProps} ref={textareaRef} rows={expanded ? 5 : 2} className="timeline-item__inline-input timeline-item__inline-input--text" placeholder="输入台词内容..." />
      : <input {...inputProps} className="timeline-item__inline-input" />}
    <CollaborativeDraftNotice visible={draft.hasRemoteUpdate} />
  </>;
}

function QuickPerformanceResourceSelect({ item, fieldKey, sceneData, timelineActions, disabled, onChange }: {
  item: SemanticTimelineReadModelItem;
  fieldKey: 'motion' | 'expression';
  sceneData: TimelineScene;
  timelineActions: readonly TimelineAction[];
  disabled: boolean;
  onChange: (patch: QuickParamPatch) => void;
}) {
  const characterAdapter = useCharacterAdapter();
  const charId = resolveCharacterPerformanceTargetCharId(item.displayAction, item.displayAction.resolvedSpeakerId);
  const character = sceneData.meta.characters?.find((candidate) => candidate.id === charId);
  const modelPath = useMemo(
    () => charId ? resolveActiveModelPath(sceneData, timelineActions, charId, item.time) : undefined,
    [sceneData, timelineActions, charId, item.time],
  );
  const { modelData, isModelDataLoading } = useCharacterModelData(characterAdapter, modelPath);
  const source = item.source.params as Record<string, unknown>;
  const isMotion = fieldKey === 'motion';
  const label = isMotion ? '动作名称' : '表情名';

  return (
    <div className="timeline-item__performance-resource" {...{ inert: disabled ? '' : undefined }}
      onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}>
      <Live2DResourceSelect
        label={label}
        value={isMotion ? characterPerformanceMotionKey(source.motion) ?? '' : String(source.expression ?? '')}
        options={isMotion ? modelData.motions : modelData.expressions}
        loading={isModelDataLoading}
        charId={charId} character={character} modelPath={modelPath}
        placeholder={isMotion ? '选择动作...' : '选择表情...'}
        clearable clearLabel={isMotion ? '（无动作）' : '（无表情）'}
        onChange={(key) => {
          if (disabled) return;
          if (isMotion) {
            onChange((current) => ({ motion: key
              ? { ...(current.motion as Record<string, unknown>), kind: 'resource', key }
              : '' }));
          } else {
            onChange((current) => ({
              expression: key || undefined,
              ...(!key && current.motion === undefined && current.lookAt === undefined && current.blink === undefined
                ? { motion: '' } : {}),
            }));
          }
        }}
        onPreview={charId ? (key) => {
          if (disabled) return;
          if (!isMotion) characterAdapter.setExpression(charId, key || '');
          else if (key) characterAdapter.playMotion(charId, key);
          else characterAdapter.stopAllMotions(charId);
        } : undefined}
      />
    </div>
  );
}

export const StatementQuickControls = memo(function StatementQuickControls({ item, sceneData, timelineActions, expanded = false, disabled, onChange }: {
  item: SemanticTimelineReadModelItem;
  sceneData: TimelineScene;
  timelineActions: readonly TimelineAction[];
  expanded?: boolean;
  disabled: boolean;
  onChange: (patch: QuickParamPatch) => void;
}) {
  const { meta: sceneMeta, visual: sceneVisual } = sceneData;
  const source = item.source.params as Record<string, unknown>;
  const fields = getStatementQuickFields(item, sceneVisual);
  const isDialogue = item.source.type === 'dialogue';
  const characters = sceneMeta.characters ?? [];

  const resourcePicker = (key: string, value: unknown, label: string) => {
    const params = source;
    const semanticType = item.source.type;
    const isImage = key === 'image'
      || (key === 'file' && (semanticType === 'environmentLayer'
        || (semanticType === 'graphicLayer' && params.kind === 'image')));
    const isAudio = key === 'voice' || key === 'audio' || key === 'bgm' || key === 'se'
      || (key === 'file' && semanticType === 'audio');
    const isAnimation = (key === 'file' || key === 'animation') && semanticType === 'customAnimation';
    const isModel = key === 'model';
    const filters = isModel
      ? [{ name: 'Live2D 模型', extensions: ['json', 'wmdl'] }]
      : isImage
        ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }]
        : isAudio
          ? [{ name: '音频', extensions: ['mp3', 'wav', 'ogg'] }]
          : isAnimation
            ? [{ name: 'HTML 动画', extensions: ['html'] }]
            : [{ name: '所有文件', extensions: ['*'] }];
    const importKind = isModel ? 'figure' : isImage ? 'images' : isAnimation ? 'animation'
      : semanticType === 'dialogue' && key === 'voice' ? 'vocal'
        : semanticType === 'audio' && key === 'file' && params.role === 'bgm' ? 'bgm' : undefined;
    const initialDir = isModel ? 'figure' : isImage ? (semanticType === 'environmentLayer' ? 'background' : 'images')
      : isAnimation ? 'animation' : semanticType === 'dialogue' && key === 'voice' ? 'vocal'
        : semanticType === 'audio' && key === 'file' && params.role === 'bgm' ? 'bgm' : undefined;
    return (
      <InlineFilePicker
        presentation="input"
        value={typeof value === 'string' ? value : ''}
        onChange={(next) => onChange({ [key]: next })}
        filters={filters}
        importKindOverride={importKind}
        initialDirOverride={initialDir}
        ariaLabel={label}
        placeholder={isModel ? '选择 Live2D 模型...' : isImage ? '选择图片...' : isAudio ? '选择音频...' : undefined}
      />
    );
  };

  return (
    <fieldset className="timeline-item__quick-fields" disabled={disabled} aria-label="基本属性">
      {fields.map((field) => {
        const value = source[field.key] === undefined ? field.defaultValue?.(source, sceneVisual) : source[field.key];
        const characterField = field.key === 'speakerId'
          || (field.key === 'id' && ['characterPresence', 'characterTransform'].includes(item.source.type))
          || (field.key === 'target' && ['characterPerformance', 'camera'].includes(item.source.type));
        if (characterField) {
          const current = typeof value === 'string' ? value : '';
          const isCameraFocus = item.source.type === 'camera' && source.mode === 'focus';
          const label = isDialogue ? '选择说话角色' : item.source.type === 'camera' ? '跟随目标' : '选择角色';
          return (
            <label key={field.key} className="timeline-item__inline-field">
              {!isDialogue && <span className="timeline-item__inline-label">{field.label}</span>}
              <FormSelect className="timeline-item__inline-select" value={current} aria-label={label}
                disabled={disabled}
                placeholder={isDialogue ? '(旁白)' : isCameraFocus ? '固定坐标' : '未绑定角色'}
                options={[
                  ...(isDialogue ? [{ value: '', label: '(旁白)' }] : []),
                  ...(isCameraFocus ? [{ value: '', label: '固定坐标' }] : []),
                  ...(current && !characters.some((character) => character.id === current)
                    ? [{ value: current, label: current }] : []),
                  ...characters.map((character) => ({ value: character.id, label: character.name })),
                ]}
                onChange={(id) => {
                  if (isCameraFocus && !id) {
                    onChange((current) => ({ target: undefined, position: current.position ?? [0.5, 0.5] }));
                    return;
                  }
                  if (!isDialogue) { onChange({ [field.key]: id }); return; }
                  const character = characters.find((candidate) => candidate.id === id);
                  onChange({ speakerId: id || undefined, speaker: character?.name, speakerColor: character?.color });
                }} />
            </label>
          );
        }
        if (quickCoordinateKeys.has(field.key)) {
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
          return <QuickTextInput key={field.key} multiline expanded={expanded} disabled={disabled}
            value={typeof value === 'string' ? value : ''} label={isDialogue ? '编辑台词内容' : field.label}
            onChange={(text) => onChange({ text })} />;
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
        if (field.key === 'motion' || field.key === 'expression') {
          const motion = value && typeof value === 'object' ? value as { kind: string; key: string } : undefined;
          if (field.key === 'expression' || motion?.kind !== 'custom') {
            return <QuickPerformanceResourceSelect key={field.key} item={item} fieldKey={field.key}
              sceneData={sceneData} timelineActions={timelineActions} disabled={disabled} onChange={onChange} />;
          }
          return (
            <label key={field.key} className="timeline-item__inline-field">
              <span className="timeline-item__inline-label">动作</span>
              <QuickTextInput label="动作名称" disabled={disabled} readOnly={motion?.kind === 'custom'}
                title={motion?.kind === 'custom' ? '展开详情编辑自定义动作' : undefined}
                value={motion?.kind === 'custom' ? '自定义动作' : motion?.key ?? ''}
                onChange={(key) => onChange((current) => ({ motion: key
                  ? { ...(current.motion as Record<string, unknown>), kind: 'resource', key }
                  : '' }))} />
            </label>
          );
        }
        if (['file', 'image', 'model', 'voice', 'audio', 'bgm', 'se', 'animation'].includes(field.key)) {
          const charId = typeof source.id === 'string' ? source.id : undefined;
          const character = charId ? characters.find((candidate) => candidate.id === charId) : undefined;
          if (field.key === 'model' && character && (character.model || character.variants?.length)) {
            const options = buildCharacterEntranceModelOptions(character);
            const currentModel = (typeof value === 'string' ? value.trim() : '') || character.model?.trim() || '';
            return (
              <label key={field.key} className="timeline-item__inline-field">
                <span className="timeline-item__inline-label">模型变体</span>
                <FormSelect className="timeline-item__inline-select" aria-label="模型变体" disabled={disabled}
                  value={currentModel} options={options}
                  placeholder={currentModel ? '自定义模型' : '未设置模型'}
                  onChange={(next) => onChange({ model: next })} />
              </label>
            );
          }
          return (
            <div key={field.key} className="timeline-item__inline-field timeline-item__inline-field--resource">
              <span className="timeline-item__inline-label">{field.label}</span>
              {resourcePicker(field.key, value, field.label)}
            </div>
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
            <QuickTextInput value={String(value ?? '')} label={label} disabled={disabled}
              onChange={(text) => onChange({ [field.key]: text })} />
          </label>
        );
      })}
    </fieldset>
  );
});
