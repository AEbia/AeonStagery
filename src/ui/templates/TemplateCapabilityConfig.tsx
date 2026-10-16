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
}: {
  packages: TemplatePackageSummary[];
  selectedIds?: string[];
  onToggle?: (templateId: string) => void;
  onMove?: (templateId: string, direction: -1 | 1) => void;
  onDeletePackage?: (templatePackage: TemplatePackageSummary) => Promise<void>;
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
    <div style={templateSelectorStyle}>
      <div style={templateSelectorHeaderStyle}>
        <div>
          <div style={fieldLabelStyle}>
            {onToggle ? '项目模板' : '已发现模板包'}
            <InfoTip content={onToggle ? '后加载模板会覆盖同名资产和组合母板。取消勾选全部模板可停用所有模板能力，保存配置后生效。' : '可删除外部模板包，包括随包导入的 WebGAL 字幕样式。内置模板可在项目中取消勾选。'} />
          </div>
        </div>
        <div style={hintTextStyle}>{onToggle ? `${selectedIds.length} 个已勾选` : `${packages.length} 个模板包`}</div>
      </div>

      <div style={templatePackageListStyle}>
        {packages.map((templatePackage) => {
          const checked = selectedIds.includes(templatePackage.id);
          const selectedIndex = selectedIds.indexOf(templatePackage.id);
          return (
            <div key={templatePackage.id} style={{ ...templatePackageRowStyle, gridTemplateColumns: onToggle ? 'auto minmax(0, 1fr) auto' : 'minmax(0, 1fr) auto' }}>
              {onToggle && <label style={templatePackageCheckStyle}>
                <input
                  type="checkbox"
                  aria-label={`启用模板 ${templatePackage.name}`}
                  checked={checked}
                  disabled={deletingId !== null}
                  onChange={() => onToggle(templatePackage.id)}
                />
              </label>}
              <span style={templatePackageTextStyle}>
                <span style={templatePackageNameStyle}>
                  {templatePackage.name}
                </span>
                <span style={templatePackageMetaStyle}>
                  {templatePackage.id} · {templatePackage.version} · {({ builtin: '内置', project: '项目', user: '用户', community: '社区' })[templatePackage.scope]}
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {checked && onMove && (
                  <span style={templatePackageOrderStyle}>
                    <span style={templatePackageOrderIndexStyle}>{selectedIndex + 1}</span>
                    <button
                      type="button"
                      className="btn btn--icon"
                      title="上移"
                      aria-label={`${templatePackage.name} 上移`}
                      disabled={deletingId !== null || selectedIndex <= 0}
                      onClick={() => onMove(templatePackage.id, -1)}
                      style={templatePackageOrderButtonStyle}
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
                      style={templatePackageOrderButtonStyle}
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
      {deletingId && <div role="status" style={hintTextStyle}>正在删除模板包…</div>}
      {deleteError && <div role="alert" style={{ ...hintTextStyle, color: 'var(--error)' }}>{deleteError}</div>}
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
  <div style={capabilityConfigStyle}>
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

    <section style={capabilityPanelStyle}>
      <div style={sectionHeaderStyle}>
        <div>
          <div style={sectionTitleStyle}>
            初始角色
            <InfoTip content="创建项目时写入默认场景；项目进行中也可以复用这一入口导入模板角色。" />
          </div>
        </div>
        <div style={hintTextStyle}>{selectedCharacterPresetIds.length} 个已选择</div>
      </div>
      <CharacterPresetSelector
        presets={characterPresets}
        selectedIds={selectedCharacterPresetIds}
        onToggle={onToggleCharacterPreset}
      />
      <div style={defaultControlRowStyle}>
        <div>
          <div style={fieldLabelStyle}>
            服装模型导入方式
            <InfoTip content="快速导入能显著减少首次复制的 Live2D 文件数量。" />
          </div>
        </div>
        <FormSelect
          value={characterVariantImportMode}
          options={[
            { value: 'primary-only', label: '快速导入（仅默认服装）' },
            { value: 'all', label: '完整导入（全部服装）' },
          ]}
          onChange={(value) => onChangeCharacterVariantImportMode(value === 'all' ? 'all' : 'primary-only')}
          style={variantImportSelectStyle}
        />
      </div>
    </section>

    <section style={capabilityPanelMutedStyle}>
      <div style={sectionTitleStyle}>
        后续能力
        <InfoTip content="Scene blueprint、模板资产、环境、文字、音频和导出 preset 会在后续决策后逐项接入。" />
      </div>
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
  <div style={templateSelectorStyle}>
    <div style={templateSelectorHeaderStyle}>
      <div>
        <div style={fieldLabelStyle}>
          初始角色
          <InfoTip content="选中的角色会写入默认场景角色目录，复数模型会保留为同一角色的副模型。" />
        </div>
      </div>
      <div style={hintTextStyle}>{selectedIds.length} 个已选择</div>
    </div>

    {presets.length > 0 ? (
      <div style={templatePackageListStyle}>
        {presets.map((preset) => {
          const checked = selectedIds.includes(preset.id);
          return (
            <div key={`${preset.templateId}:${preset.id}`} style={templatePackageRowStyle}>
              <label style={templatePackageCheckStyle}>
                <input
                  type="checkbox"
                  aria-label={`选择初始角色 ${preset.name}`}
                  checked={checked}
                  onChange={() => onToggle(preset.id)}
                />
              </label>
              <span style={templatePackageTextStyle}>
                <span style={templatePackageNameStyle}>
                  {preset.name}
                  <span style={templatePackageScopeStyle}>{preset.variantCount} 模型</span>
                  {preset.speakerColor && (
                    <span style={{ ...characterColorSwatchStyle, background: preset.speakerColor }} />
                  )}
                </span>
                <span style={templatePackageMetaStyle}>
                  {preset.id} · {preset.templateName}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    ) : (
      <div style={emptyTemplateStateStyle}>当前启用模板没有角色预设</div>
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
  <section style={capabilityPanelStyle}>
    <div style={sectionHeaderStyle}>
      <div>
        <div style={sectionTitleStyle}>
          {title}
          <InfoTip content={description} />
        </div>
      </div>
      <div style={hintTextStyle}>{formatDefaultSource(resolved)}</div>
    </div>
    {presets.length > 0 ? (
      <div style={defaultControlRowStyle}>
        <FormSelect
          value={resolved.value ?? ''}
          options={presets.map((preset) => ({
            value: preset.id,
            label: `${preset.name} · ${preset.templateName}`,
          }))}
          onChange={(value) => onChange(value || undefined)}
          style={selectStyle}
        />
        <button
          className="btn"
          type="button"
          onClick={() => onChange(undefined)}
          disabled={resolved.source !== 'user'}
          style={resetButtonStyle}
        >
          使用模板默认
        </button>
      </div>
    ) : (
      <div style={emptyTemplateStateStyle}>{emptyText}</div>
    )}
  </section>
);

const templateSelectorStyle: React.CSSProperties = {
  display: 'grid',
  gap: 9,
  paddingTop: 2,
};

const capabilityConfigStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
};

const capabilityPanelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  padding: 14,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-tertiary)',
};

const capabilityPanelMutedStyle: React.CSSProperties = {
  ...capabilityPanelStyle,
  borderStyle: 'dashed',
  background: 'var(--bg-primary)',
};

const templateSelectorHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

const sectionTitleStyle: React.CSSProperties = {
  color: 'var(--text-primary)',
  fontSize: 15,
  fontWeight: 850,
};

const fieldLabelStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 800,
};

const hintTextStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 12,
  lineHeight: 1.5,
};

const defaultControlRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 8,
  alignItems: 'center',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  minHeight: 38,
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  padding: '8px 10px',
};

const resetButtonStyle: React.CSSProperties = {
  minHeight: 38,
  padding: '8px 12px',
};

const variantImportSelectStyle: React.CSSProperties = {
  ...selectStyle,
  width: 230,
};

const templatePackageListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 7,
};

const templatePackageRowStyle: React.CSSProperties = {
  minHeight: 44,
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 9,
  padding: '8px 10px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-tertiary)',
};

const templatePackageCheckStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};

const templatePackageTextStyle: React.CSSProperties = {
  minWidth: 0,
  overflowWrap: 'anywhere',
  display: 'grid',
  gap: 3,
};

const templatePackageNameStyle: React.CSSProperties = {
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  color: 'var(--text-primary)',
  fontSize: 12,
  fontWeight: 760,
};

const templatePackageScopeStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: '1px 5px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-secondary)',
  fontSize: 10,
  fontWeight: 700,
};

const templatePackageMetaStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-muted)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
};

const templatePackageOrderStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '22px 28px 28px',
  alignItems: 'center',
  gap: 4,
};

const templatePackageOrderIndexStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  textAlign: 'center',
};

const templatePackageOrderButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  minHeight: 28,
};

const characterColorSwatchStyle: React.CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: 'var(--radius-full)',
  border: '1px solid var(--border-highlight)',
  boxShadow: 'var(--shadow-sm)',
};

const emptyTemplateStateStyle: React.CSSProperties = {
  minHeight: 48,
  display: 'flex',
  alignItems: 'center',
  color: 'var(--text-muted)',
  fontSize: 12,
};
