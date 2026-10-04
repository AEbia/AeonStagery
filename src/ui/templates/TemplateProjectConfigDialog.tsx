import React, { useEffect, useMemo, useState } from 'react';
import type { TemplatePackageSummary } from '../../services/template-package';
import {
  DEFAULT_PROJECT_TEMPLATE_CONFIGURATION,
  type CharacterVariantImportMode,
  type ProjectTemplateDefaults,
  type ProjectTemplateConfiguration,
} from '../../api/types/project';
import {
  buildAvailableCharacterPresets,
  buildAvailableDialogueStyles,
  resolveTemplateDefaultValue,
  TemplateCapabilityConfig,
  TemplatePackageSelector,
} from './TemplateCapabilityConfig';
import { useModalDialog } from '../hooks/useModalDialog';

interface TemplateProjectConfigDialogProps {
  embedded?: boolean;
  isOpen: boolean;
  templatePackages: TemplatePackageSummary[];
  value?: ProjectTemplateConfiguration;
  onClose: () => void;
  onSave: (templates: ProjectTemplateConfiguration, options?: { importCharacters?: boolean }) => void | Promise<void>;
}

const canonicalizeTemplateIds = (
  ids: string[],
  packages: TemplatePackageSummary[],
): string[] => [...new Set(ids.map((id) => (
  packages.find((templatePackage) => (
    templatePackage.id === id || templatePackage.aliases?.includes(id)
  ))?.id ?? id
)))];

export const TemplateProjectConfigDialog = ({
  isOpen,
  embedded = false,
  templatePackages,
  value,
  onClose,
  onSave,
}: TemplateProjectConfigDialogProps) => {
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>(
    () => value?.enabledTemplateIds ?? DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.enabledTemplateIds,
  );
  const [selectedCharacterPresetIds, setSelectedCharacterPresetIds] = useState<string[]>(
    () => value?.selectedCharacterPresetIds ?? DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.selectedCharacterPresetIds ?? [],
  );
  const [characterVariantImportMode, setCharacterVariantImportMode] = useState<CharacterVariantImportMode>(
    () => value?.characterVariantImportMode ?? DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.characterVariantImportMode ?? 'primary-only',
  );
  const [defaultOverrides, setDefaultOverrides] = useState<ProjectTemplateDefaults>(
    () => ({ ...(value?.defaults ?? {}) }),
  );
  const [isSaving, setIsSaving] = useState(false);
  const dialogRef = useModalDialog(onClose, isOpen && !embedded);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedTemplateIds(canonicalizeTemplateIds(
      value?.enabledTemplateIds ?? DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.enabledTemplateIds,
      templatePackages,
    ));
    setSelectedCharacterPresetIds(value?.selectedCharacterPresetIds ?? DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.selectedCharacterPresetIds ?? []);
    setCharacterVariantImportMode(
      value?.characterVariantImportMode ?? DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.characterVariantImportMode ?? 'primary-only',
    );
    setDefaultOverrides({ ...(value?.defaults ?? {}) });
  }, [isOpen, templatePackages, value]);

  useEffect(() => {
    const availableIds = new Set(templatePackages.map((templatePackage) => templatePackage.id));
    setSelectedTemplateIds((current) => {
      const filtered = current.filter((id) => availableIds.has(id));
      if (filtered.length > 0) {
        if (filtered.length === current.length && filtered.every((id, index) => id === current[index])) {
          return current;
        }
        return filtered;
      }
      const defaults = DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.enabledTemplateIds;
      if (current.length === defaults.length && current.every((id, index) => id === defaults[index])) {
        return current;
      }
      return defaults;
    });
  }, [templatePackages]);

  const availableCharacterPresets = useMemo(
    () => buildAvailableCharacterPresets(templatePackages, selectedTemplateIds),
    [selectedTemplateIds, templatePackages],
  );
  const availableDialogueStyles = useMemo(
    () => buildAvailableDialogueStyles(templatePackages, selectedTemplateIds),
    [selectedTemplateIds, templatePackages],
  );
  const resolvedDialogueStyle = useMemo(
    () => resolveTemplateDefaultValue(
      'dialogueStyleId',
      templatePackages,
      selectedTemplateIds,
      defaultOverrides,
      DEFAULT_PROJECT_TEMPLATE_CONFIGURATION.defaults?.dialogueStyleId,
    ),
    [defaultOverrides, selectedTemplateIds, templatePackages],
  );

  useEffect(() => {
    const availableIds = new Set(availableCharacterPresets.map((preset) => preset.id));
    setSelectedCharacterPresetIds((current) => current.filter((id) => availableIds.has(id)));
  }, [availableCharacterPresets]);

  if (!isOpen) return null;

  const toggleTemplate = (templateId: string) => {
    setSelectedTemplateIds((current) => {
      if (current.includes(templateId)) {
        const next = current.filter((id) => id !== templateId);
        return next.length > 0 ? next : current;
      }
      const availableOrder = templatePackages.map((templatePackage) => templatePackage.id);
      return [...current, templateId].sort((left, right) =>
        availableOrder.indexOf(left) - availableOrder.indexOf(right),
      );
    });
  };

  const moveTemplate = (templateId: string, direction: -1 | 1) => {
    setSelectedTemplateIds((current) => {
      const index = current.indexOf(templateId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const toggleCharacterPreset = (presetId: string) => {
    setSelectedCharacterPresetIds((current) => (
      current.includes(presetId)
        ? current.filter((id) => id !== presetId)
        : [...current, presetId]
    ));
  };

  const handleChangeDialogueStyleOverride = (styleId: string | undefined) => {
    updateDefaultOverride('dialogueStyleId', styleId);
  };

  const updateDefaultOverride = (key: keyof ProjectTemplateDefaults, value: string | undefined) => {
    setDefaultOverrides((current) => {
      const next = { ...current };
      if (!value) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const handleSave = async (options: { importCharacters?: boolean } = {}) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await onSave({
        enabledTemplateIds: selectedTemplateIds,
        defaults: Object.keys(defaultOverrides).length > 0 ? defaultOverrides : undefined,
        selectedCharacterPresetIds,
        characterVariantImportMode,
      }, options);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div ref={dialogRef} className={embedded ? "settings-template-panel" : undefined} style={embedded ? undefined : backdropStyle} role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby={embedded ? undefined : "template-project-config-title"}>
      <section style={embedded ? { display: "flex", flexDirection: "column", gap: 16 } : dialogStyle}>
        {!embedded && <header style={headerStyle}>
          <div>
            <h2 id="template-project-config-title" style={titleStyle}>模板能力配置</h2>
            <div style={subtitleStyle}>调整当前项目的模板包顺序和能力选择。</div>
          </div>
          <button className="btn" onClick={onClose} style={compactButtonStyle}>关闭</button>
        </header>}

        <div style={embedded ? { display: "grid", gap: 16 } : contentStyle}>
          <TemplatePackageSelector
            packages={templatePackages}
            selectedIds={selectedTemplateIds}
            onToggle={toggleTemplate}
            onMove={moveTemplate}
          />
          <TemplateCapabilityConfig
            dialogueStyles={availableDialogueStyles}
            resolvedDialogueStyle={resolvedDialogueStyle}
            onChangeDialogueStyleOverride={handleChangeDialogueStyleOverride}
            characterPresets={availableCharacterPresets}
            selectedCharacterPresetIds={selectedCharacterPresetIds}
            onToggleCharacterPreset={toggleCharacterPreset}
            characterVariantImportMode={characterVariantImportMode}
            onChangeCharacterVariantImportMode={setCharacterVariantImportMode}
          />
        </div>

        <footer style={embedded ? { display: "flex", flexDirection: "column", gap: 12 } : footerStyle}>
          <div style={hintTextStyle}>
            {characterVariantImportMode === 'all'
              ? '完整导入会复制所选角色的全部服装；已有同 ID 角色会补充缺少的服装。'
              : '快速导入只复制默认服装；之后可切换为完整导入来补充全部服装。'}
          </div>
          <div style={footerActionsStyle}>
            <button
              className="btn"
              onClick={() => { void handleSave({ importCharacters: true }); }}
              disabled={isSaving || selectedCharacterPresetIds.length === 0}
              style={secondaryButtonStyle}
            >
              保存并导入角色
            </button>
            <button className="btn btn--primary" onClick={() => { void handleSave(); }} disabled={isSaving} style={primaryButtonStyle}>
              {isSaving ? '正在保存...' : '保存配置'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
};

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 160,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  background: 'rgba(0,0,0,0.54)',
  backdropFilter: 'blur(10px)',
  animation: 'settingsOverlayIn 180ms ease-out',
};

const dialogStyle: React.CSSProperties = {
  width: 'min(880px, 100%)',
  maxHeight: 'min(780px, calc(100vh - 48px))',
  display: 'grid',
  gridTemplateRows: 'auto minmax(0, 1fr) auto',
  gap: 14,
  padding: 18,
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-xl)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  boxShadow: 'var(--shadow-premium)',
  transformOrigin: 'center',
  animation: 'settingsDialogIn 220ms cubic-bezier(0.16, 1, 0.3, 1)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--text-primary)',
  fontSize: 18,
  lineHeight: 1.25,
  letterSpacing: 0,
};

const subtitleStyle: React.CSSProperties = {
  marginTop: 4,
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.5,
};

const contentStyle: React.CSSProperties = {
  minHeight: 0,
  display: 'grid',
  gap: 14,
  overflowY: 'auto',
  paddingRight: 4,
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 16,
};

const footerActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  flexShrink: 0,
};

const hintTextStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 12,
  lineHeight: 1.5,
};

const compactButtonStyle: React.CSSProperties = {
  minHeight: 36,
  padding: '8px 12px',
};

const primaryButtonStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '9px 16px',
};

const secondaryButtonStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '9px 14px',
};
