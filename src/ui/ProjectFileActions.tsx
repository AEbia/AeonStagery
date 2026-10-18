import type { ProjectState } from '../api/types/project';
import { FileRevealButton, FileRevealContext } from './FileRevealActions';
import { useDetailsDismissal } from './hooks/useDetailsDismissal';

/** File locations for the loaded project and all persisted scene entries. */
export function ProjectFileActions({ project }: { project: ProjectState }) {
  const detailsRef = useDetailsDismissal();
  return <FileRevealContext path={project.projectFilePath} name={project.metadata.name}>
    <details className="top-bar__more" ref={detailsRef}>
      <summary className="btn" aria-label="项目与场景文件位置">文件位置</summary>
      <div className="top-bar__menu" style={{ maxHeight: 'min(60vh, 420px)', overflowY: 'auto' }}>
        <FileRevealButton path={project.projectFilePath} name={`项目：${project.metadata.name}`} className="top-bar__menu-item" />
        {project.metadata.scenes.map((scene) => <FileRevealContext key={scene.id} path={scene.path} projectRoot={project.rootPath} name={scene.name || scene.path}>
          <div style={{ padding: '4px 8px', minWidth: 0 }}>
            <div title={scene.path} style={{ overflowWrap: 'anywhere', fontSize: 11, color: 'var(--text-muted)' }}>{scene.name || scene.path}</div>
            <FileRevealButton path={scene.path} projectRoot={project.rootPath} name={`场景：${scene.name || scene.path}`} className="top-bar__menu-item" />
          </div>
        </FileRevealContext>)}
      </div>
    </details>
  </FileRevealContext>;
}
