import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileRevealButton, FileRevealContext } from '../../FileRevealActions';
import { IconPencil, IconSearch, IconTrash } from '../../icons';
import { useModalDialog } from '../../hooks/useModalDialog';
import type { ProjectHomeProps } from '../ProjectHome';
import type { RecentProjectEntry } from '../../SettingsStore';
import { buildStageSignature } from './stageSignature';
import { StageSignatureRails } from './StageSignatureRails';
import { filterRecentProjects, formatAbsoluteTime, formatRelativeTime } from './recentProjects';

type Props = Pick<ProjectHomeProps, 'recentProjects' | 'onRenameRecentProject' | 'onRemoveRecentProject'> & {
  now: number;
  openingRecentPath: string | null;
  onOpen: (path: string) => void;
};

export function RecentProjectList({ recentProjects, now, openingRecentPath, onOpen, onRenameRecentProject, onRemoveRecentProject }: Props) {
  const [query, setQuery] = useState('');
  const [projectToRemove, setProjectToRemove] = useState<RecentProjectEntry | null>(null);
  const projects = useMemo(() => filterRecentProjects(recentProjects, query), [recentProjects, query]);
  const removeRecentDialogRef = useModalDialog(() => setProjectToRemove(null), projectToRemove !== null);

  return <section className="ph-recents" aria-label="最近项目">
    <div className="ph-recents__heading">
      <h2>最近项目 <span className="ph-recents__count">{recentProjects.length}</span></h2>
      <div className="ph-recents__search"><IconSearch width={14} height={14} />
        <input type="search" className="ph-input" aria-label="搜索最近项目" placeholder="搜索名称或路径" value={query}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') { event.preventDefault(); setQuery(''); }
            if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && projects[0]) {
              event.preventDefault();
              onOpen(projects[0].projectFilePath);
            }
          }} />
      </div>
    </div>
    <div className="ph-recents__list">
      {projects.map((project) => <FileRevealContext key={project.projectFilePath} path={project.projectFilePath} name={project.name}>
        <div className="ph-recents__item">
          <button type="button" className="ph-recents__open" aria-label={`打开最近项目：${project.name}`}
            disabled={openingRecentPath !== null} title={project.rootPath} onClick={() => onOpen(project.projectFilePath)}>
            <span className="ph-recents__thumbnail"><StageSignatureRails blocks={buildStageSignature(project.rootPath, 3)} /></span>
            <span className="ph-recents__copy"><strong>{project.name}</strong><span>{project.rootPath}</span></span>
            <time className="ph-recents__time" dateTime={project.lastOpenedAt}
              title={formatAbsoluteTime(project.lastOpenedAt)}>{formatRelativeTime(project.lastOpenedAt, now)}</time>
          </button>
          <div className="ph-recents__actions">
            <FileRevealButton path={project.projectFilePath} name={project.name} compact />
            <button type="button" className="btn btn--icon" aria-label={`重命名项目：${project.name}`} title="重命名项目"
              disabled={openingRecentPath !== null} onClick={() => onRenameRecentProject(project)}><IconPencil width={14} height={14} /></button>
            <button type="button" className="btn btn--icon btn--danger" aria-label={`移除最近项目：${project.name}`} title="移除最近项目"
              onClick={() => setProjectToRemove(project)}><IconTrash width={14} height={14} /></button>
          </div>
        </div>
      </FileRevealContext>)}
      {projects.length === 0 && <div className="ph-recents__empty" role="status">
        {query.trim() ? <>没有匹配“{query}”的项目<button type="button" className="btn" onClick={() => setQuery('')}>清除搜索</button></> : '暂无最近项目'}
      </div>}
    </div>
    {projectToRemove && createPortal(<div className="modal-overlay" onClick={(event) => {
      if (event.target === event.currentTarget) setProjectToRemove(null);
    }}>
      <div ref={removeRecentDialogRef} className="modal ph-recents__delete-dialog" role="dialog" aria-modal="true"
        aria-labelledby="recent-project-delete-title" tabIndex={-1}>
        <div className="modal__header"><IconTrash width={18} height={18} /><span id="recent-project-delete-title">移除最近项目？</span></div>
        <div className="ph-recents__delete-project" title={projectToRemove.rootPath}>{projectToRemove.name}</div>
        <div className="modal__footer">
          <button type="button" className="btn" onClick={() => setProjectToRemove(null)}>取消</button>
          <button type="button" className="btn btn--danger" onClick={() => {
            onRemoveRecentProject(projectToRemove.projectFilePath);
            setProjectToRemove(null);
          }}>移除</button>
        </div>
      </div>
    </div>, document.body)}
  </section>;
}
