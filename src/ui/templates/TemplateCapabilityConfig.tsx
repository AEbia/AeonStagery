import React, { useState } from 'react';
import type { TemplatePackageSummary } from '../../services/template-package';
import type {
  CharacterVariantImportMode,
  ProjectTemplateDefaults,
} from '../../api/types/project';
import { DEFAULT_DIALOGUE_STYLE_ID } from '../../api/types/project';
import { IconChevronDown, IconChevronUp, IconTrash } from '../icons';
import { FormSelect } from '../FormSelect';
import { InfoTip } from '../Tooltip';
import './template-package-selector.css';
import './template-capability-config.css';

export type CharacterPresetListItem = NonNullable<TemplatePackageSummary['characterPresets']>[number] & {
  templateScope: TemplatePackageSummary['scope'];
  templateId: string;
  templateName: string;
};

export type DialogueStyleListItem = NonNullable<TemplatePackageSummary['dialogueStyles']>[number] & {
  templateScope: TemplatePackageSummary['scope'];
  templateId: string;
  templateName: string;
};

export interface ResolvedTemplateDefaultValue {
  value?: string;
  source: 'user' | 'template' | 'builtin';
  templateName?: string;
}

export const templateScopeRank = (scope: TemplatePackageSummary['scope']) => {
  if (scope === 'project') return 0;
  if (scope === 'user') return 1;
  if (scope === 'community') return 2;
  return 3;
};

export const compareTemplatePresetPrecedence = (
  left: CharacterPresetListItem,
  right: CharacterPresetListItem,
  selectedTemplateIds: string[],
) => {
  const scopeDelta = templateScopeRank(left.templateScope) - templateScopeRank(right.templateScope);
  if (scopeDelta !== 0) return scopeDelta;
  return selectedTemplateIds.lastIndexOf(right.templateId) - selectedTemplateIds.lastIndexOf(left.templateId);
};

export const buildAvailableCharacterPresets = (
  packages: TemplatePackageSummary[],
  selectedTemplateIds: string[],
): CharacterPresetListItem[] => {
  const selectedTemplateIdSet = new Set(selectedTemplateIds);
  const candidates = packages
    .filter((templatePackage) => selectedTemplateIdSet.has(templatePackage.id))
    .flatMap((templatePackage) => (templatePackage.characterPresets ?? []).map((preset) => ({
      ...preset,
      templateScope: templatePackage.scope,
      templateId: templatePackage.id,
      templateName: templatePackage.name,
    })));
  const byId = new Map<string, CharacterPresetListItem>();
  for (const preset of candidates.sort((left, right) => compareTemplatePresetPrecedence(left, right, selectedTemplateIds))) {
    if (!byId.has(preset.id)) byId.set(preset.id, preset);
  }
  return [...byId.values()];
};

export const buildAvailableDialogueStyles = (
  packages: TemplatePackageSummary[],
  selectedTemplateIds: string[],
): DialogueStyleListItem[] => {
  const selectedTemplateIdSet = new Set(selectedTemplateIds);
  const candidates = packages
    .filter((templatePackage) => selectedTemplateIdSet.has(templatePackage.id))
    .flatMap((templatePackage) => (templatePackage.dialogueStyles ?? []).map((style) => ({
      ...style,
      name: ({
        glass: '玻璃',
        minimal: '极简',
        classic: '经典',
        [DEFAULT_DIALOGUE_STYLE_ID]: '沉浸字幕',
      } as Record<string, string>)[style.id] ?? style.name,
      templateScope: templatePackage.scope,
      templateId: templatePackage.id,
      templateName: templatePackage.name,
    })));
  const byId = new Map<string, DialogueStyleListItem>();
  for (const style of candidates.sort((left, right) => compareTemplateRecordPrecedence(left, right, selectedTemplateIds))) {
    if (!byId.has(style.id)) byId.set(style.id, style);
  }
  return [...byId.values()];
};

export const resolveTemplateDefaultValue = (
  key: keyof ProjectTemplateDefaults,
  packages: TemplatePackageSummary[],
  selectedTemplateIds: string[],
  userDefaults: ProjectTemplateDefaults | undefined,
  builtinValue?: string,
): ResolvedTemplateDefaultValue => {
  const userValue = userDefaults?.[key];
  if (userValue) {
    return { value: userValue, source: 'user' };
  }

  const selectedTemplateIdSet = new Set(selectedTemplateIds);
  const candidates = packages
    .filter((templatePackage) => selectedTemplateIdSet.has(templatePackage.id) && templatePackage.defaults?.[key])
    .map((templatePackage) => ({
      templateScope: templatePackage.scope,
      templateId: templatePackage.id,
      templateName: templatePackage.name,
      value: templatePackage.defaults?.[key],
    }))
    .sort((left, right) => compareTemplateRecordPrecedence(left, right, selectedTemplateIds));

  if (candidates[0]?.value) {
    return {
      value: candidates[0].value,
      source: 'template',
      templateName: candidates[0].templateName,
    };
  }

  return { value: builtinValue, source: 'builtin' };
};

const compareTemplateRecordPrecedence = (
  left: { templateScope: TemplatePackageSummary['scope']; templateId: string },
  right: { templateScope: TemplatePackageSummary['scope']; templateId: string },
  selectedTemplateIds: string[],
) => {
  const scopeDelta = templateScopeRank(left.templateScope) - templateScopeRank(right.templateScope);
  if (scopeDelta !== 0) return scopeDelta;
  return selectedTemplateIds.lastIndexOf(right.templateId) - selectedTemplateIds.lastIndexOf(left.templateId);
};

export const TemplatePackageSelector = ({
  packages,
  selectedIds = [],
  onToggle,
  onMove,
  onDeletePackage,
  compact = false,
  headerActions,
}: {
  packages: TemplatePackageSummary[];
  selectedIds?: string[];
  onToggle?: (templateId: string) => void;
  onMove?: (templateId: string, direction: -1 | 1) => void;
  onDeletePackage?: (templatePackage: TemplatePackageSummary) => Promise<void>;
  compact?: boolean;
  headerActions?: React.ReactNode;
}) => {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const deletePackage = async (templatePackage: TemplatePackageSummary) => {
    if (!onDeletePackage || deletingId) return;
    setDeletingId(templatePackage.id);
    setDeleteError('');
    try {
      await onDeletePackage(templatePackage);
    } catch (error) {
      setDeleteError(`模板包删除失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeletingId(null);
    }
  };
  return (
    <div className={`template-package-selector${compact ? ' template-package-selector--compact' : ''}`}>
      <div className="template-package-selector-header">
        <div className="template-package-selector-heading">
          <div className="template-control-label">
            {onToggle ? '项目模板' : '已发现模板包'}
            <InfoTip content={onToggle ? '后加载模板覆盖同名资产和组合母板，全部取消勾选并保存可停用模板能力。' : '可删除外部模板包及其 WebGAL 字幕样式，内置模板需在项目中取消勾选。'} />
          </div>
          {compact && <div className="template-hint">{onToggle ? `${selectedIds.length} 个已勾选 / ${packages.length} 个模板包` : `${packages.length} 个模板包`}</div>}
        </div>
        {!compact && <div className="template-hint">{onToggle ? `${selectedIds.length} 个已勾选` : `${packages.length} 个模板包`}</div>}
        {headerActions}
      </div>

      <div
        className="template-package-selector-list"
        role={compact && packages.length > 0 ? 'region' : undefined}
        aria-label={compact && packages.length > 0 ? (onToggle ? '项目模板列表' : '模板包列表') : undefined}
        tabIndex={compact && packages.length > 0 ? 0 : undefined}
      >
        {packages.map((templatePackage) => {
          const checked = selectedIds.includes(templatePackage.id);
          const selectedIndex = selectedIds.indexOf(templatePackage.id);
          const scopeLabel = ({ builtin: '内置', project: '项目', user: '用户', community: '社区' })[templatePackage.scope];
          const metadata = `${templatePackage.id} · ${templatePackage.version} · ${scopeLabel}`;
          return (
            <div className="template-package-selector-row template-preset-row" key={templatePackage.id}
              data-selectable={Boolean(onToggle)} data-selected={checked}>
              {onToggle && <label className="template-package-check">
                <input
                  type="checkbox"
                  aria-label={`启用模板 ${templatePackage.name}`}
                  checked={checked}
                  disabled={deletingId !== null}
                  onChange={() => onToggle(templatePackage.id)}
                />
              </label>}
              <span className="template-preset-text">
                <span className="template-package-selector-name template-preset-name" title={templatePackage.name}>
                  {templatePackage.name}
                </span>
                <span title={metadata} className="template-preset-meta">
                  {metadata}
                </span>
              </span>
              <span className="template-package-actions">
                {checked && onMove && (
                  <span className="template-package-order">
                    <span className="template-package-order__index">{selectedIndex + 1}</span>
                    <button
                      type="button"
                      className="btn btn--icon"
                      title="上移"
                      aria-label={`${templatePackage.name} 上移`}
                      disabled={deletingId !== null || selectedIndex <= 0}
                      onClick={() => onMove(templatePackage.id, -1)}
                    >
                      <IconChevronUp width={13} height={13} />
                    </button>
                    <button
                      type="button"
                      className="btn btn--icon"
                      title="下移"
                      aria-label={`${templatePackage.name} 下移`}
                      disabled={deletingId !== null || selectedIndex === selectedIds.length - 1}
                      onClick={() => onMove(templatePackage.id, 1)}
                    >
                      <IconChevronDown width={13} height={13} />
                    </button>
                  </span>
                )}
                {onDeletePackage && templatePackage.scope !== 'builtin' && templatePackage.packageRoot && (
                  <button
                    type="button"
                    className="btn btn--icon btn--danger"
                    title="删除模板包"
                    aria-label={`删除模板包 ${templatePackage.name}`}
                    disabled={deletingId !== null}
                    onClick={() => { void deletePackage(templatePackage); }}
                  >
                    <IconTrash width={14} height={14} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {compact && packages.length === 0 && <div className="template-hint">暂无模板包</div>}
      {deletingId && <div role="status" className="template-hint">正在删除模板包…</div>}
      {deleteError && <div role="alert" className="template-hint template-hint--error">{deleteError}</div>}
    </div>
  );
};

export const TemplateCapabilityConfig = ({
  dialogueStyles,
  resolvedDialogueStyle,
  onChangeDialogueStyleOverride,
  characterPresets,
  selectedCharacterPresetIds,
  onToggleCharacterPreset,
  characterVariantImportMode,
  onChangeCharacterVariantImportMode,
}: {
  dialogueStyles?: DialogueStyleListItem[];
  resolvedDialogueStyle?: ResolvedTemplateDefaultValue;
  onChangeDialogueStyleOverride?: (styleId: string | undefined) => void;
  characterPresets: CharacterPresetListItem[];
  selectedCharacterPresetIds: string[];
  onToggleCharacterPreset: (presetId: string) => void;
  characterVariantImportMode: CharacterVariantImportMode;
  onChangeCharacterVariantImportMode: (mode: CharacterVariantImportMode) => void;
}) => (
  <div className="template-capability-config">
    {dialogueStyles && resolvedDialogueStyle && onChangeDialogueStyleOverride && (
      <DefaultPresetSelector
        title="默认对白样式"
        description="模板可以建议默认值；用户手动选择后不会被后续模板静默覆盖。"
        emptyText="当前启用模板没有对白样式"
        presets={dialogueStyles}
        resolved={resolvedDialogueStyle}
        onChange={onChangeDialogueStyleOverride}
      />
    )}

    <section className="template-capability-panel">
      <div className="template-capability-panel__header">
        <div>
          <h2 className="template-capability-panel__title">
            初始角色
            <InfoTip content="所选角色会写入默认场景并保留副模型，也可在项目中通过此入口追加导入。" />
          </h2>
        </div>
        <div className="template-hint">{selectedCharacterPresetIds.length} 个已选择</div>
      </div>
      <CharacterPresetSelector
        presets={characterPresets}
        selectedIds={selectedCharacterPresetIds}
        onToggle={onToggleCharacterPreset}
      />
      <div className="template-capability-panel__controls">
        <div>
          <div className="template-control-label">
            服装模型导入方式
            <InfoTip content="快速导入能显著减少首次复制的 Live2D 文件数量。" />
          </div>
        </div>
        <FormSelect
          aria-label="服装模型导入方式"
          value={characterVariantImportMode}
          options={[
            { value: 'primary-only', label: '快速导入（仅默认服装）' },
            { value: 'all', label: '完整导入（全部服装）' },
          ]}
          onChange={(value) => onChangeCharacterVariantImportMode(value === 'all' ? 'all' : 'primary-only')}
          className="template-capability-panel__select template-capability-panel__variant"
        />
      </div>
    </section>

    <section className="template-capability-panel template-capability-panel--muted">
      <h2 className="template-capability-panel__title">
        后续能力
        <InfoTip content="Scene blueprint、模板资产、环境、文字、音频和导出 preset 会在后续决策后逐项接入。" />
      </h2>
    </section>
  </div>
);

const formatDefaultSource = (resolved: ResolvedTemplateDefaultValue) => {
  if (resolved.source === 'user') return '用户已覆盖';
  if (resolved.source === 'template') return `来自模板：${resolved.templateName ?? ''}`;
  return '内置默认';
};

const CharacterPresetSelector = ({
  presets,
  selectedIds,
  onToggle,
}: {
  presets: CharacterPresetListItem[];
  selectedIds: string[];
  onToggle: (presetId: string) => void;
}) => (
  <div className="template-character-presets">
    {presets.length > 0 ? (
      <div className="template-preset-list">
        {presets.map((preset) => (
          <label key={`${preset.templateId}:${preset.id}`} className="template-preset-row template-preset-row--character"
            data-selected={selectedIds.includes(preset.id)}>
            <input type="checkbox" aria-label={`选择初始角色 ${preset.name}`}
              checked={selectedIds.includes(preset.id)} onChange={() => onToggle(preset.id)} />
            <span className="template-preset-text">
              <span className="template-preset-name">
                {preset.name}
                <span className="template-preset-scope">{preset.variantCount} 模型</span>
                {preset.speakerColor && <span className="template-character-color" style={{ background: preset.speakerColor }} />}
              </span>
              <span className="template-preset-meta">{preset.id} · {preset.templateName}</span>
            </span>
          </label>
        ))}
      </div>
    ) : (
      <div className="template-empty-state">当前启用模板没有角色预设</div>
    )}
  </div>
);

const DefaultPresetSelector = ({
  title,
  description,
  emptyText,
  presets,
  resolved,
  onChange,
}: {
  title: string;
  description: string;
  emptyText: string;
  presets: Array<{ id: string; name: string; templateId: string; templateName: string }>;
  resolved: ResolvedTemplateDefaultValue;
  onChange: (presetId: string | undefined) => void;
}) => (
  <section className="template-capability-panel">
    <div className="template-capability-panel__header">
      <div>
        <h2 className="template-capability-panel__title">
          {title}
          <InfoTip content={description} />
        </h2>
      </div>
      <div className="template-hint">{formatDefaultSource(resolved)}</div>
    </div>
    {presets.length > 0 ? (
      <div className="template-capability-panel__controls">
        <FormSelect
          aria-label={title}
          value={resolved.value ?? ''}
          options={presets.map((preset) => ({
            value: preset.id,
            label: `${preset.name} · ${preset.templateName}`,
          }))}
          onChange={(value) => onChange(value || undefined)}
          className="template-capability-panel__select"
        />
        <button
          className="btn"
          type="button"
          onClick={() => onChange(undefined)}
          disabled={resolved.source !== 'user'}
        >
          使用模板默认
        </button>
      </div>
    ) : (
      <div className="template-empty-state">{emptyText}</div>
    )}
  </section>
);
