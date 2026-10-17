import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { TemplatePackageDeleteRequest } from '../src/api/types/template-package-import';
import { parseTemplatePackageManifest } from '../src/services/template-package/TemplatePackageManifest';

/** Validate the package on disk before asking for confirmation or moving it to trash. */
export async function inspectTemplatePackageForDeletion(
  request: TemplatePackageDeleteRequest,
  protectedRoots: readonly string[],
) {
  if (!request || typeof request.id !== 'string' || !request.id.trim()
    || typeof request.packageRoot !== 'string' || !path.isAbsolute(request.packageRoot)) {
    throw new Error('模板包删除请求无效');
  }
  const packageRoot = path.resolve(request.packageRoot);
  const stat = await lstat(packageRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('只能删除模板包目录，不能删除符号链接');
  }
  const resolvedRoot = await realpath(packageRoot);
  for (const protectedRoot of protectedRoots) {
    // Windows may return an 8.3 short path for a temporary or selected path,
    // while realpath resolves the package path to its long form. Canonicalize
    // both sides before checking containment so aliases cannot bypass protection.
    const resolvedProtectedRoot = await realpath(path.resolve(protectedRoot));
    const relative = path.relative(resolvedProtectedRoot, resolvedRoot);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('不能删除内置模板包');
    }
  }
  const isTemplateDirectory = (directory: string) => ['template', 'templates'].includes(path.basename(directory).toLowerCase());
  if (!isTemplateDirectory(packageRoot) && !isTemplateDirectory(path.dirname(packageRoot))) {
    throw new Error('只能删除 template 或 templates 目录中的模板包');
  }
  const manifest = parseTemplatePackageManifest(JSON.parse(await readFile(path.join(packageRoot, 'manifest.v2.json'), 'utf8')));
  if (manifest.template.id !== request.id) {
    throw new Error('模板包已发生变化，请刷新后重试');
  }
  // Discovery supports a manifest at the template root as well as child packages.
  // Removing such a root must never silently remove its other packages.
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const childDirectory = path.join(packageRoot, entry.name);
    for (const manifestName of ['manifest.v2.json', 'manifest.json']) {
      try {
        await lstat(path.join(childDirectory, manifestName));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      throw new Error('此目录包含其他模板包或旧格式管理数据，请先单独移除它们');
    }
  }
  return { packageRoot, id: manifest.template.id, name: manifest.template.name };
}
