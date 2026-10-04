import React from 'react';
import { EngineSnapshotTab, DiagnosticsTab } from './ActionInspectorTabs';
import type { SceneMeta } from '../../api/types/scene-common';
import type { TimelineAction } from './semanticTimelineTypes';
import {
  IconChevronRight,
  IconExternalLink,
} from '../icons';
import { CharacterDirectoryPanel } from './CharacterDirectoryPanel';
import type { WorkspaceToolTab } from '../workspace-tools/types';
import { InspectorViewPicker } from './InspectorViewPicker';

const RawScriptTab = React.lazy(async () => {
  const module = await import('./RawScriptTab');
  return { default: module.RawScriptTab };
});

export interface ContextPanelProps {
  sceneMeta: SceneMeta;
  actionCount: number;
  globalIssues: any[];
  action?: TimelineAction;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  width: number;
  activeTab: WorkspaceToolTab;
  setActiveTab: (tab: WorkspaceToolTab) => void;
  onDetach?: () => void;
  canDetach?: boolean;
  embedded?: boolean;
}

export const ContextPanel: React.FC<ContextPanelProps> = ({
  sceneMeta,
  actionCount,
  globalIssues,
  action,
  isOpen,
  setIsOpen,
  width,
  activeTab,
  setActiveTab,
  onDetach,
  canDetach = false,
  embedded = false,
}) => {
  const errorCount = globalIssues.filter((issue) => issue.severity === 'error').length;
  const warningCount = globalIssues.filter((issue) => issue.severity === 'warning').length;

  if (!isOpen) {
    return (
      <button type="button" className="context-panel-rail" onClick={() => setIsOpen(true)} title="打开工作区工具" aria-label="打开工作区工具">
        <IconChevronRight width={22} height={22} />
        <span className="sr-only">打开工作区工具</span>
      </button>
    );
  }

  return (
    <aside
      className={`context-panel${embedded ? ' context-panel--embedded' : ''}`}
      style={embedded ? undefined : { width }}
      aria-label="工作区工具"
    >
      <div className="context-panel__tabs">
        <InspectorViewPicker
          activeView={activeTab}
          actionCount={actionCount}
          characterCount={sceneMeta.characters?.length ?? 0}
          errorCount={errorCount}
          warningCount={warningCount}
          onSelect={(view) => {
            if (view === 'actions') {
              setIsOpen(false);
              return;
            }
            setActiveTab(view);
          }}
        />
        <div className="context-panel__spacer" />
        {canDetach && onDetach && (
          <button className="btn btn--icon context-panel__collapse" onClick={onDetach} title="弹出为独立窗口" aria-label="弹出工作区工具为独立窗口">
            <IconExternalLink width={16} height={16} />
          </button>
        )}
      </div>
      <div className="context-panel__body">
        {activeTab === 'characters' && <CharacterDirectoryPanel sceneMeta={sceneMeta} />}
        {activeTab === 'snapshot' && <EngineSnapshotTab action={action} sceneMeta={sceneMeta} />}
        {activeTab === 'script' && (
          <React.Suspense fallback={<div style={{ padding: 16, color: 'var(--text-muted)' }}>正在加载代码编辑器...</div>}>
            <RawScriptTab action={action} />
          </React.Suspense>
        )}
        {activeTab === 'diagnostics' && <DiagnosticsTab globalIssues={globalIssues} />}
      </div>
    </aside>
  );
};
