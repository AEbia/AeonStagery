import type { AeonStageryElectronAPI } from '../api/types/window';
import type { ProjectResourceService } from '../services/io/ProjectResourceService';
import { ProjectPathResolver } from '../services/io/ProjectPathResolver';

export interface FileRevealTarget {
  path: string;
  /** Template browser entries already point to their package, outside project lookup. */
  templateResource?: boolean;
  /** Scene document paths are owned by a project and must never use global resource lookup. */
  projectRoot?: string;
}

export interface FileRevealServices {
  projectResources?: Pick<ProjectResourceService, 'resolveForReadWithStatus'>;
}

/** Resolve portable references through their owner before crossing the native boundary. */
export async function revealFileInManager(
  target: FileRevealTarget,
  api: AeonStageryElectronAPI | undefined = window.aeonStageryAPI,
  services: FileRevealServices | undefined = window.AeonStagery?.services as FileRevealServices | undefined,
): Promise<void> {
  if (!api?.fs?.showItemInFolder) throw new Error('当前环境不支持文件定位，请在桌面应用中重试。');
  const path = await resolveTargetPath(target, api, services);
  const result = await api.fs.showItemInFolder(path);
  if (!result.success) throw new Error(result.error || '文件定位失败，请检查文件是否存在后重试。');
}

/** Open a directory itself, rather than selecting it in its parent directory. */
export async function openFolderInManager(
  target: FileRevealTarget,
  api: AeonStageryElectronAPI | undefined = window.aeonStageryAPI,
  services: FileRevealServices | undefined = window.AeonStagery?.services as FileRevealServices | undefined,
): Promise<void> {
  if (!api?.fs?.openFolder) throw new Error('当前环境不支持打开文件夹，请在桌面应用中重试。');
  const path = await resolveTargetPath(target, api, services);
  const result = await api.fs.openFolder(path);
  if (!result.success) throw new Error(result.error || '文件夹打开失败，请检查路径后重试。');
}

async function resolveTargetPath(
  target: FileRevealTarget,
  api: AeonStageryElectronAPI,
  services: FileRevealServices | undefined,
): Promise<string> {
  const resolver = new ProjectPathResolver();
  let path = target.path;
  if (!path.trim() || /[\u0000-\u001f]/.test(path)
    || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))) {
    throw new Error('无法定位此路径，请选择文件系统路径。');
  }
  if (target.projectRoot) {
    if (!api.path?.join) throw new Error('桌面路径服务不可用，请在桌面应用中重试。');
    path = await api.path.join(target.projectRoot, path);
  } else if (!resolver.isAbsolutePath(path)) {
    if (target.templateResource) {
      // The filesystem service knows the installed application root for built-in packages.
      const result = await api.fs.realpath(path);
      if (!result.success || !result.data) throw new Error(result.error || '模板资源不可用，请重新打开项目后重试。');
      path = result.data;
    } else {
      if (!services?.projectResources) throw new Error('项目资源服务不可用，请重新打开项目后重试。');
      const resolution = await services.projectResources.resolveForReadWithStatus(path);
      if (resolution.status !== 'ready') {
        if (resolution.status === 'mount-unbound' || resolution.status === 'mount-root-missing') {
          throw new Error('外部资源库未绑定或已移动，请在资源库设置中重新绑定后重试。');
        }
        throw new Error('文件不存在或资源引用无效，请检查资源路径后重试。');
      }
      path = resolution.path;
    }
  }
  return path;
}
