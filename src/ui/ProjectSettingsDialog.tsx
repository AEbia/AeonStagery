import { useId, useState } from 'react';
import type { ProjectState } from '../api/types/project';
import type { IProjectWorkspaceService } from '../api/interfaces/IProjectWorkspaceService';
import { useModalDialog } from './hooks/useModalDialog';
import { ProjectVideoSettings } from './settings/ProjectVideoSettings';
import { IconX } from './icons';
import './videoFormat.css';

export function ProjectSettingsDialog({ project, workspace, onClose }: {
  project: ProjectState;
  workspace: IProjectWorkspaceService;
  onClose: () => void;
}) {
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  const close = () => { if (!saving) onClose(); };
  const dialogRef = useModalDialog(close, true);
  return (
    <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialogRef} className="modal project-settings-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal__header">
          <div className="project-settings-dialog__heading">
            <h2 id={titleId}>画布设置</h2>
            <p>{project.metadata.name}</p>
          </div>
          <button type="button" className="btn btn--icon" onClick={close} disabled={saving} aria-label="关闭画布设置"><IconX /></button>
        </div>
        <div className="project-settings-dialog__body">
          <ProjectVideoSettings project={project} workspace={workspace} onSavingChange={setSaving} />
        </div>
      </div>
    </div>
  );
}
