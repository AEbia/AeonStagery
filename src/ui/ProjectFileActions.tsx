import { useState } from 'react';
import type { ProjectState } from '../api/types/project';
import { openFolderInManager } from './fileReveal';
import { IconFolder } from './icons';
import { showToast } from './Toast';

/** The editor's folder icon opens the current project, without switching projects. */
export function ProjectFileActions({ project, disabled = false }: { project: ProjectState; disabled?: boolean }) {
  const [pending, setPending] = useState(false);
  return <button type="button" className="btn btn--icon top-bar__project-action"
    disabled={disabled || pending} aria-busy={pending} aria-label="打开当前项目文件夹"
    title={`打开当前项目文件夹：${project.rootPath}`} onClick={() => {
      setPending(true);
      void openFolderInManager({ path: project.rootPath }).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : '项目文件夹打开失败，请重试。', 'error');
      }).finally(() => setPending(false));
    }}>
    <IconFolder width={15} height={15} />
  </button>;
}
