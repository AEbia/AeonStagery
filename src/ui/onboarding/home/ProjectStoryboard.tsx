import { type CSSProperties, type KeyboardEvent, type RefObject, useId, useRef, useState } from 'react';
import type { RecentProjectEntry } from '../../SettingsStore';
import { FileRevealButton } from '../../FileRevealActions';
import { IconChevronLeft, IconChevronRight, IconPause, IconPlay, IconPlus } from '../../icons';
import { formatAbsoluteTime, formatRelativeTime } from './recentProjects';
import { useStoryboardMotion } from './useStoryboardMotion';
import './storyboard.css';

type BoardStyle = CSSProperties & {
  '--board-offset': number;
  '--board-distance': number;
  '--board-angle': string;
  '--board-order': number;
  '--cover-angle': string;
};

/** Path-derived geometry identifies a project; it never claims to preview its scene. */
function coverAngle(path: string): string {
  let hash = 0;
  for (const character of path) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return `${Math.abs(hash % 90) - 45}deg`;
}

function ProjectCoverTitle({ project }: { project: RecentProjectEntry }) {
  const datedName = /^AeonStagery Project\s+(\d{4})-(\d{2})-(\d{2})(.*)$/i.exec(project.name.trim());
  return <span className={`ph-board__cover-title${datedName ? ' ph-board__cover-title--date' : ''}`}>
    {datedName ? <>
      <span>{datedName[2]}.{datedName[3]}</span>
      <span className="ph-board__cover-detail">{datedName[1]}{datedName[4].trim() && ` · ${datedName[4].trim()}`}</span>
    </> : <span className="ph-board__cover-name">{project.name.trim() || '未命名项目'}</span>}
  </span>;
}

export function ProjectStoryboard({ projects, project, now, opening, primaryRef, onSelect, onOpen, onCreate, onStartTutorial }: {
  projects: RecentProjectEntry[];
  project?: RecentProjectEntry;
  now: number;
  opening: boolean;
  primaryRef: RefObject<HTMLButtonElement>;
  onSelect: (path: string | null) => void;
  onOpen: (path: string) => void;
  onCreate: () => void;
  onStartTutorial: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const stageRef = useStoryboardMotion(paused || opening);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const selectedIndex = project ? projects.findIndex((entry) => entry.projectFilePath === project.projectFilePath) : projects.length;
  const select = (index: number, focus = false) => {
    if (opening) return;
    setEngaged(true);
    onSelect(projects[index]?.projectFilePath ?? null);
    if (focus) tabs.current[index]?.focus({ preventScroll: true });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let next: number;
    switch (event.key) {
      case 'ArrowRight': next = Math.min(projects.length, index + 1); break;
      case 'ArrowLeft': next = Math.max(0, index - 1); break;
      case 'Home': next = 0; break;
      case 'End': next = projects.length; break;
      default: return;
    }
    event.preventDefault();
    select(next, true);
  };

  return <section ref={stageRef} className="ph-storyboard" aria-labelledby={`${id}-title`}
    data-motion="paused" data-opening={opening || undefined} data-engaged={engaged || opening || undefined} aria-busy={opening}>
    <div className="ph-board__toolbar">
      <h2>选择项目</h2>
      <span className="ph-board__position" aria-label={`第 ${selectedIndex + 1} 张，共 ${projects.length + 1} 张`}>
        {String(selectedIndex + 1).padStart(2, '0')}<span> / {String(projects.length + 1).padStart(2, '0')}</span>
      </span>
      <div className="ph-board__controls">
        <button type="button" className="btn btn--icon ph-board__motion" onClick={() => { setEngaged(true); setPaused(!paused); }}
          aria-label={paused ? '恢复分镜动效' : '暂停分镜动效'} title={paused ? '恢复分镜动效' : '暂停分镜动效'}>
          {paused ? <IconPlay width={14} height={14} /> : <IconPause width={14} height={14} />}
        </button>
        <button type="button" className="btn btn--icon" aria-label="上一张分镜" disabled={opening || selectedIndex === 0}
          onClick={() => select(selectedIndex - 1)}><IconChevronLeft width={18} height={18} /></button>
        <button type="button" className="btn btn--icon" aria-label="下一张分镜" disabled={opening || selectedIndex === projects.length}
          onClick={() => select(selectedIndex + 1)}><IconChevronRight width={18} height={18} /></button>
      </div>
    </div>
    <div className="ph-board__viewport">
      <div className="ph-board__table" aria-hidden="true" />
      <div className="ph-board__camera">
        <div className="ph-board__float" role="tablist" aria-label="选择项目">
          {[...projects, null].map((entry, index) => {
            const offset = index - selectedIndex;
            const active = offset === 0;
            const style: BoardStyle = {
              '--board-offset': offset,
              '--board-distance': Math.abs(offset),
              '--board-angle': `${offset === 0 ? -3 : offset < 0 ? 32 : -32}deg`,
              '--board-order': index,
              '--cover-angle': coverAngle(entry?.rootPath ?? 'new-project'),
              zIndex: projects.length + 1 - Math.abs(offset),
            };
            return <div className="ph-board__slot" key={entry?.projectFilePath ?? 'create'} style={style}
              onAnimationEnd={(event) => {
                if (event.animationName === 'ph-board-deal' && index === projects.length) setEngaged(true);
              }}
              data-selected={active || undefined} data-distant={Math.abs(offset) > 2 || undefined}>
              <button type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-details`}
                aria-selected={active} aria-label={entry ? `选择项目：${entry.name}` : '选择新建项目'}
                tabIndex={active ? 0 : -1} disabled={opening}
                ref={(element) => { tabs.current[index] = element; }}
                className={`ph-board__card${entry ? '' : ' ph-board__card--new'}`}
                title={active ? entry ? `打开项目：${entry.name}` : '创建新项目' : undefined}
                onClick={() => {
                  if (!active) select(index);
                  else if (entry) onOpen(entry.projectFilePath);
                  else onCreate();
                }} onKeyDown={(event) => handleKeyDown(event, index)}>
                <span className="ph-board__cover" aria-hidden="true">
                  <span className="ph-board__cover-orbit" />
                  <span className="ph-board__cover-plane" />
                  {entry ? <ProjectCoverTitle project={entry} />
                    : <span className="ph-board__cover-title"><IconPlus width={64} height={64} /></span>}
                  <span className="ph-board__cover-corners" />
                </span>
                <span className="ph-board__card-info">
                  <span className="ph-board__card-number" aria-hidden="true">{entry ? String(index + 1).padStart(2, '0') : '+'}</span>
                  <span className="ph-board__card-name">{entry?.name ?? '新建项目'}</span>
                </span>
              </button>
            </div>;
          })}
        </div>
      </div>
    </div>
    <div id={`${id}-details`} role="tabpanel" aria-labelledby={`${id}-tab-${selectedIndex}`} className="ph-board__details">
      <div className="ph-board__project-copy" key={project?.projectFilePath ?? 'create'}>
        <h1 id={`${id}-title`} className="ph-board__title">{project?.name ?? '舞台已就绪'}</h1>
        {project ? <p className="ph-board__meta">{selectedIndex === 0 ? '继续上次' : '上次打开'} · <time dateTime={project.lastOpenedAt}
          title={formatAbsoluteTime(project.lastOpenedAt)}>{formatRelativeTime(project.lastOpenedAt, now)}</time></p>
          : <p className="ph-board__meta">从一个镜头开始，让故事登场。</p>}
      </div>
      <div className="ph-board__actions">
        {project ? <>
          <button type="button" ref={primaryRef} className="btn btn--primary ph-board__open"
            aria-label={`继续制作：${project.name}`} disabled={opening} onClick={() => onOpen(project.projectFilePath)}>
            <IconPlay width={15} height={15} />{opening ? '正在打开…' : '继续制作'}<kbd aria-hidden="true">Enter</kbd>
          </button>
          <FileRevealButton path={project.projectFilePath} name={project.name} />
        </> : <>
          <button type="button" className="btn btn--primary ph-board__open" onClick={onCreate}>
            <IconPlus width={16} height={16} />{projects.length ? '创建新项目' : '创建第一个项目'}
          </button>
          <button type="button" className="btn ph-board__tutorial" onClick={onStartTutorial}>跟随教程制作第一幕</button>
        </>}
      </div>
      {project && <span className="ph-board__path" title={project.rootPath}>{project.rootPath}</span>}
    </div>
  </section>;
}
