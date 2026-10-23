import { useEffect, useState } from 'react';
import { DEFAULT_VIDEO_FORMAT, validateVideoFormat } from '../../api/types/video-format';
import type { ProjectState } from '../../api/types/project';
import type { IProjectWorkspaceService } from '../../api/interfaces/IProjectWorkspaceService';
import { VideoFormatFields } from '../VideoFormatFields';

export function ProjectVideoSettings({ project, workspace, onSavingChange }: { project: ProjectState | null; workspace?: IProjectWorkspaceService; onSavingChange?: (saving: boolean) => void }) {
  const [format, setFormat] = useState(project?.metadata.videoFormat ?? DEFAULT_VIDEO_FORMAT);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setFormat(project?.metadata.videoFormat ?? DEFAULT_VIDEO_FORMAT);
  }, [project?.metadata.projectId, project?.metadata.videoFormat]);
  useEffect(() => { setMessage(''); }, [project?.metadata.projectId]);
  if (!project || !workspace) return <p className="video-format__message">打开项目后，可设置画布尺寸和默认帧率。</p>;
  const error = validateVideoFormat(format);
  return (
    <section className="project-video-settings">
      <div className="project-video-settings__content">
        <div className="project-video-settings__intro">
          <h3>分辨率与帧率</h3>
          <p className="video-format__message">画布比例决定构图。相同比例下提高分辨率会增加渲染像素；修改帧率不会改变动画时长。预览清晰度可在播放条单独调整。</p>
        </div>
        <VideoFormatFields value={format} onChange={next => { setFormat(next); setMessage(''); }} idPrefix="project-video" disabled={saving} />
        {error && <p role="alert" className="video-format__error">{error}</p>}
      </div>
      <div className="project-video-settings__footer">
        {message && <p role="status" className="video-format__message">{message}</p>}
        <button type="button" className="btn btn--primary" disabled={saving || !!error} onClick={async () => {
          setSaving(true);
          onSavingChange?.(true);
          try {
            const result = await workspace.updateVideoFormat(format);
            setMessage(result.success ? '画布设置已保存。' : result.error);
          } catch (error: unknown) {
            setMessage(error instanceof Error ? error.message : String(error));
          } finally { setSaving(false); onSavingChange?.(false); }
        }}>{saving ? '正在应用并保存…' : '保存画布设置'}</button>
      </div>
    </section>
  );
}
