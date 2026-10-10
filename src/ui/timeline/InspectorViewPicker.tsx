import React from 'react';
import {
  IconActivity,
  IconChevronDown,
  IconError,
  IconFileText,
  IconLayers,
  IconUser,
} from '../icons';
import type { WorkspaceToolTab } from '../workspace-tools/types';
import { useSettings } from '../SettingsStore';

export type InspectorPanelView = 'actions' | WorkspaceToolTab;

export const inspectorViewSupportsActionDetail = (view: InspectorPanelView) => (
  view === 'actions' || view === 'diagnostics' || view === 'snapshot'
);

interface InspectorViewPickerProps {
  activeView: InspectorPanelView;
  actionCount: number;
  characterCount: number;
  errorCount: number;
  warningCount: number;
  onSelect: (view: InspectorPanelView) => void;
}

const viewDefinitions: Array<{
  id: InspectorPanelView;
  label: string;
  icon: React.ComponentType<{ width?: number; height?: number }>;
}> = [
  { id: 'actions', label: '剧本动作', icon: IconLayers },
  { id: 'characters', label: '角色管理', icon: IconUser },
  { id: 'diagnostics', label: '问题', icon: IconError },
  { id: 'script', label: '场景 JSON', icon: IconFileText },
  { id: 'snapshot', label: '运行快照', icon: IconActivity },
];

export const InspectorViewPicker: React.FC<InspectorViewPickerProps> = ({
  activeView,
  actionCount,
  characterCount,
  errorCount,
  warningCount,
  onSelect,
}) => {
  const { settings } = useSettings();
  if (settings.workbenchTimelineLayoutMode === 'tracks') return null;

  const activeDefinition = viewDefinitions.find((view) => view.id === activeView) ?? viewDefinitions[0];
  const ActiveIcon = activeDefinition.icon;
  const issueCount = errorCount + warningCount;
  const alertSeverity = errorCount > 0
    ? 'error'
    : warningCount > 0 || characterCount === 0
      ? 'warning'
      : undefined;
  const alertTitle = [
    errorCount > 0 ? `${errorCount} 个错误` : '',
    warningCount > 0 ? `${warningCount} 个警告` : '',
    characterCount === 0 ? '尚未配置角色' : '',
  ].filter(Boolean).join('；');

  const getValue = (view: InspectorPanelView): string | number | undefined => {
    if (view === 'actions') return actionCount;
    if (view === 'characters') return characterCount === 0 ? '未配置' : characterCount;
    if (view === 'diagnostics') return issueCount > 0 ? issueCount : '无';
    return undefined;
  };

  const getAriaLabel = (view: InspectorPanelView, label: string) => {
    if (view === 'actions') return `${label}，${actionCount} 个`;
    if (view === 'characters') {
      return characterCount === 0 ? `${label}，未配置` : `${label}，${characterCount} 个角色`;
    }
    if (view === 'diagnostics') {
      return issueCount > 0 ? `${label}，${issueCount} 个` : `${label}，无`;
    }
    return label;
  };

  const activeValue = getValue(activeView);

  return (
    <details className="inspector-view-picker">
      <summary
        aria-label={`切换侧栏视图，当前为${activeDefinition.label}${alertTitle ? `，${alertTitle}` : ''}`}
      >
        <ActiveIcon width={15} height={15} />
        <strong>{activeDefinition.label}</strong>
        {activeValue !== undefined && <span>{activeValue}</span>}
        {alertTitle && (
          <b
            className="inspector-view-picker__alert"
            data-severity={alertSeverity}
            title={alertTitle}
          >
            {issueCount > 0 ? issueCount : '!'}
          </b>
        )}
        <IconChevronDown width={13} height={13} />
      </summary>
      <div className="inspector-view-picker__menu" role="menu">
        {viewDefinitions.map((view) => {
          const Icon = view.icon;
          const value = getValue(view.id);
          const severity = view.id === 'diagnostics'
            ? errorCount > 0
              ? 'error'
              : warningCount > 0
                ? 'warning'
                : undefined
            : view.id === 'characters' && characterCount === 0
              ? 'warning'
              : undefined;

          return (
            <button
              key={view.id}
              type="button"
              data-active={view.id === activeView}
              onClick={(event) => {
                event.currentTarget.closest('details')?.removeAttribute('open');
                onSelect(view.id);
              }}
              role="menuitemradio"
              aria-checked={view.id === activeView}
              aria-label={getAriaLabel(view.id, view.label)}
            >
              <Icon width={15} height={15} />
              <span>{view.label}</span>
              {value !== undefined && <em data-severity={severity}>{value}</em>}
            </button>
          );
        })}
      </div>
    </details>
  );
};
