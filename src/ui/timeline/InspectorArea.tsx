import { TimelineListView } from './TimelineListView';
import { useMemo, useSyncExternalStore } from 'react';
import {
  useDocumentStore,
  useTemplatePackageCatalog,
} from '../context/AppContext';
import { ContextPanel } from './ContextPanel';
import type { SaveResult } from '../../services/io/SceneFileService';
import type { InspectorPanelView } from './InspectorViewPicker';
import { buildSemanticTimelineReadModel } from './semanticTimelineReadModel';
import { resolveMatchingTimelineAction } from './selectionHygiene';
import type { TimelineScene } from './semanticTimelineTypes';
import { useSemanticDocument } from '../store/storeHooks';
import { useSettings } from '../SettingsStore';
import { PropertyInspectorShell } from './PropertyInspectorShell';

export interface InspectorAreaProps {
  sceneData: TimelineScene;
  selectedActionIds: Record<string, boolean>;
  setSelectedIds: (ids: Record<string, boolean>) => void;
  inspectorTab: 'basic' | 'transform' | 'state';
  setInspectorTab: (t: 'basic' | 'transform' | 'state') => void;
  updateAction: (id: string, updates: any) => void;
  updateParam: (id: string, key: string, val: any) => void;
  replaceSourceParams?: (id: string, params: Record<string, unknown>) => void;
  deleteAction: (id: string) => void;
  deleteActions?: (ids: readonly string[]) => void | Promise<void>;
  copyActions?: (ids: readonly string[]) => void;
  addActionAt: (time: number) => void;
  addAction: () => void;
  handleSave: () => void | Promise<SaveResult | undefined>;
  handleSelect: (idOrIds: string | string[], multi?: boolean) => void;
  setCurrentTime: (t: number) => void;
  loadExample: () => Promise<boolean>;
  detailOpen: boolean;
  detailClosing?: boolean;
  detailSelectedActionIds?: Record<string, boolean>;
  onDetailOpen: () => void;
  onDetailClose: () => void;
  layoutMode: 'split' | 'replace';
  navigatorWidth: number;
  detailWidth: number;
  onDetailResizeStart?: (event: React.MouseEvent) => void;
  onDetailResizeKeyDown?: (event: React.KeyboardEvent) => void;
  workspaceIssues?: any[];
  inspectorView: InspectorPanelView;
  onSelectInspectorView?: (view: InspectorPanelView) => void;
  onDetachWorkspaceTools?: () => void;
  canDetachWorkspaceTools?: boolean;
}

const ListInspectorArea = (props: InspectorAreaProps) => {
  const documentStore = useDocumentStore();
  const templateCatalog = useTemplatePackageCatalog();
  const templatePackageSnapshot = useSyncExternalStore(
    templateCatalog ? (listener) => templateCatalog.subscribe(listener) : () => () => {},
    templateCatalog ? () => templateCatalog.getPackages() : getStableEmptyPackages,
    getStableEmptyPackages,
  );
  const availableTemplates = useMemo(
    () => {
      void templatePackageSnapshot;
      return templateCatalog?.getSemanticAuthoringCombos() ?? [];
    },
    [templateCatalog, templatePackageSnapshot],
  );
  const { document: semanticDocument } = useSemanticDocument();
  const items = useMemo(
    () => buildSemanticTimelineReadModel(semanticDocument, documentStore.getCompiledSceneSnapshot()),
    [documentStore, semanticDocument],
  );
  const selectedIds = Object.keys(props.selectedActionIds);
  const selectedAction = selectedIds.length === 1
    ? resolveMatchingTimelineAction(items.map((item) => item.displayAction), selectedIds[0])
    : undefined;

  return (
    <div
      className="inspector-workspace__pane inspector-workspace__pane--navigator"
      data-timeline-layout="list"
    >
      {props.inspectorView === 'actions' ? (
        <TimelineListView
          sceneData={props.sceneData}
          inlineExpandable
          selectedActionIds={props.selectedActionIds}
          setSelectedIds={props.setSelectedIds}
          addAction={props.addAction}
          handleSelect={props.handleSelect}
          setCurrentTime={props.setCurrentTime}
          loadExample={props.loadExample}
          workspaceErrorCount={props.workspaceIssues?.filter((issue) => issue.severity === 'error').length ?? 0}
          workspaceWarningCount={props.workspaceIssues?.filter((issue) => issue.severity === 'warning').length ?? 0}
          availableTemplates={availableTemplates}
          onSelectWorkspaceView={(view) => props.onSelectInspectorView?.(view)}
          updateAction={props.updateAction}
          updateParam={props.updateParam}
          replaceSourceParams={props.replaceSourceParams}
          deleteAction={props.deleteAction}
          deleteActions={props.deleteActions}
          copyActions={props.copyActions}
        />
      ) : (
        <ContextPanel
          sceneMeta={props.sceneData.meta}
          actionCount={items.length}
          globalIssues={props.workspaceIssues ?? []}
          action={selectedAction}
          isOpen
          setIsOpen={(open) => { if (!open) props.onSelectInspectorView?.('actions'); }}
          width={props.navigatorWidth}
          activeTab={props.inspectorView}
          setActiveTab={(view) => props.onSelectInspectorView?.(view)}
          onDetach={props.onDetachWorkspaceTools}
          canDetach={props.canDetachWorkspaceTools}
          embedded
        />
      )}
    </div>
  );
};

export const InspectorArea = (props: InspectorAreaProps) => {
  const { settings } = useSettings();
  const isTracksMode = settings.workbenchTimelineLayoutMode === 'tracks';

  if (isTracksMode) {
    return <PropertyInspectorShell {...props} />;
  }
  return <ListInspectorArea {...props} />;
};

const stableEmptyPackages: never[] = [];
const getStableEmptyPackages = () => stableEmptyPackages;
