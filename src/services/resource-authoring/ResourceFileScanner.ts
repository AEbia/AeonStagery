import type { IFileAccess } from '../io/IFileAccess';

export async function listResourceFiles(
  fileAccess: Pick<IFileAccess, 'readDir'>,
  root: string,
): Promise<string[]> {
  const files: string[] = [];
  await walk(root, '');
  return files.sort((a, b) => a.localeCompare(b));

  async function walk(absoluteDir: string, relativeDir: string): Promise<void> {
    let entries: Awaited<ReturnType<IFileAccess['readDir']>>;
    try {
      entries = await fileAccess.readDir(absoluteDir);
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walk(entry.path, relative);
      else files.push(relative.replace(/\\/g, '/'));
    }
  }
}
