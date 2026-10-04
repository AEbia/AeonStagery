import { useEffect } from 'react';
import type { TemplateResourceFileService } from '../services/template-package/TemplateResourceFileService';

/** Shared with ResourceLibrary, which reads the desktop application's services. */
export function getTemplateResourceFileService(): TemplateResourceFileService | undefined {
  return typeof window === 'undefined' ? undefined : window.AeonStagery?.services?.templateResourceFiles;
}

export function useTemplateResourceDirectoryRefresh(refresh: () => void): void {
  const service = getTemplateResourceFileService();
  useEffect(() => service?.subscribe(refresh), [service, refresh]);
}
