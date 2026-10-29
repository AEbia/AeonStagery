import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { MAX_RECENT_PROJECTS } from '../../SettingsStore';
import type { ProjectHomeProps } from '../ProjectHome';
import { ProjectStoryboard } from './ProjectStoryboard';
import { RecentProjectList } from './RecentProjectList';
import { TemplateLibraryPanel } from './TemplateLibraryPanel';
import './startView.css';

type Props = Pick<ProjectHomeProps, 'recentProjects' | 'onOpenRecentProject' | 'onRenameRecentProject' |
  'onRemoveRecentProject' | 'templatePackages' | 'onImportTemplatePackage' | 'onDeleteTemplatePackage' | 'onStartTutorial'> & {
    onCreate: () => void;
    selectionMemory?: MutableRefObject<{ path: string | null } | null>;
  };

export function StartView({ recentProjects, onOpenRecentProject, onRenameRecentProject, onRemoveRecentProject,
  templatePackages, onImportTemplatePackage, onDeleteTemplatePackage, onStartTutorial, onCreate, selectionMemory }: Props) {
  const [now, setNow] = useState(Date.now);
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null);
  const openingRef = useRef(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const projects = recentProjects.slice(0, MAX_RECENT_PROJECTS);
  const [selection, setSelection] = useState<{ path: string | null } | null>(() => selectionMemory?.current ?? null);
  const selectProject = useCallback((path: string | null) => {
    const next = { path };
    if (selectionMemory) selectionMemory.current = next;
    setSelection(next);
  }, [selectionMemory]);
  const selectedProject = selection?.path === null ? undefined
    : projects.find((project) => project.projectFilePath === selection?.path) ?? projects[0];
  const selectedPath = selectedProject?.projectFilePath;
  const handleOpen = useCallback(async (path: string) => {
    if (openingRef.current || primaryRef.current?.closest('[inert]')) return;
    openingRef.current = true;
    selectProject(path);
    setOpeningRecentPath(path);
    try { await onOpenRecentProject(path); }
    finally { openingRef.current = false; setOpeningRecentPath(null); }
  }, [onOpenRecentProject, selectProject]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!document.querySelector('[aria-modal="true"]')) primaryRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || document.activeElement !== document.body || document.querySelector('[aria-modal="true"]')
        || primaryRef.current?.closest('[inert]') || !selectedPath) return;
      event.preventDefault();
      void handleOpen(selectedPath);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleOpen, selectedPath]);

  return <div className="ph-start">
    <ProjectStoryboard projects={projects} project={selectedProject} now={now} opening={openingRecentPath !== null} primaryRef={primaryRef} onSelect={selectProject}
      onOpen={(path) => { void handleOpen(path); }} onCreate={onCreate} onStartTutorial={onStartTutorial} />
    <div className="ph-start__library">
      <RecentProjectList recentProjects={projects} now={now} openingRecentPath={openingRecentPath}
        onOpen={(path) => { void handleOpen(path); }} onRenameRecentProject={onRenameRecentProject} onRemoveRecentProject={onRemoveRecentProject} />
      <TemplateLibraryPanel templatePackages={templatePackages} onImportTemplatePackage={onImportTemplatePackage}
        onDeleteTemplatePackage={onDeleteTemplatePackage} />
    </div>
  </div>;
}
