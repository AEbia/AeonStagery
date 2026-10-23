import { useSyncExternalStore } from 'react';
import { useOptionalApp } from '../context/AppContext';
import { DEFAULT_VIDEO_FORMAT } from '../../api/types/video-format';

export function useProjectVideoFormat() {
  const workspace = useOptionalApp()?.services?.projectWorkspace;
  const project = useSyncExternalStore(
    listener => workspace?.subscribe(listener) ?? (() => {}),
    () => workspace?.getCurrentProject() ?? null,
    () => null,
  );
  return project?.metadata.videoFormat ?? DEFAULT_VIDEO_FORMAT;
}
