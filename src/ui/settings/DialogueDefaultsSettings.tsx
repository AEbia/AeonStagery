import { useState, useSyncExternalStore } from 'react';
import { DEFAULT_PROJECT_TEMPLATE_CONFIGURATION } from '../../api/types/project';
import { useOptionalApp } from '../context/AppContext';
import { FormSelect } from '../FormSelect';
import { buildAvailableDialogueStyles, resolveTemplateDefaultValue } from '../templates/TemplateCapabilityConfig';

export function DialogueDefaultsSettings() {
  const app = useOptionalApp();
  const workspace = app?.services?.projectWorkspace;
  const catalog = app?.services?.templatePackages;
  const project = useSyncExternalStore(
    workspace ? (listener) => workspace.subscribe(listener) : () => () => {},
    workspace ? () => workspace.getCurrentProject() : () => null,
    () => null,
  );
  // Subscribe to catalog changes so the summaries are refreshed after updates.
  useSyncExternalStore(
    catalog ? (listener) => catalog.subscribe(listener) : () => () => {},
    catalog ? () => catalog.getRevision() : () => 0,
    () => 0,
  );
  const summaries = catalog?.getSummaries() ?? [];
  const templates = project?.metadata.templates ?? DEFAULT_PROJECT_TEMPLATE_CONFIGURATION;
  const styles = buildAvailableDialogueStyles(summaries, templates.enabledTemplateIds);
  const resolved = resolveTemplateDefaultValue('dialogueStyleId', summaries, templates.enabledTemplateIds, templates.defaults, 'glass');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function saveStyle(styleId?: string) {
    if (!workspace || saving) return;
    const current = workspace.getCurrentProject();
    if (!current) return;
    const currentTemplates = current.metadata.templates ?? DEFAULT_PROJECT_TEMPLATE_CONFIGURATION;
    const defaults = { ...currentTemplates.defaults };
    if (styleId) defaults.dialogueStyleId = styleId;
    else delete defaults.dialogueStyleId;
    setSaving(true);
    setError('');
    try {
      const result = await workspace.updateTemplateConfiguration({ ...currentTemplates, defaults });
      if (!result.success) setError(result.error);
    } catch {
      setError('对白样式保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-dialog__card-stack">
      <div className="settings-dialog__helper">新添加的对白使用此样式。已有对白可在属性面板单独调整。</div>
      <div className="settings-dialog__field-row">
        <FormSelect
          aria-label="默认对白样式"
          style={{ flex: 1, minWidth: 0 }}
          value={resolved.value ?? 'glass'}
          disabled={!project || saving || styles.length === 0}
          options={styles.map((style) => ({ value: style.id, label: style.name }))}
          onChange={(value) => void saveStyle(value)}
        />
        <button type="button" className="btn" disabled={!project || saving || resolved.source !== 'user'} onClick={() => void saveStyle()}>使用模板默认</button>
      </div>
      {!project && <div className="settings-dialog__helper">打开项目后可设置默认对白样式。</div>}
      {saving && <div role="status">正在保存对白样式…</div>}
      {error && <div role="alert" className="settings-dialog__message">{error}</div>}
    </div>
  );
}
