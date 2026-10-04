import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  VOICE_LIBRARY_SCHEMA_VERSION,
  createModelSelector,
  validateLocalVoicePreset,
  type LocalVoicePreset,
  type SaveLocalVoicePresetRequest,
  type ScanVoiceCatalogRequest,
  type VoiceCatalogIssue,
  type VoiceCatalogModel,
  type VoiceCatalogReference,
  type VoiceCatalogResult,
  type VoiceLibraryDocument,
} from '../src/services/voice/VoiceAuthoringTypes';
import { parseTemplatePackageManifest } from '../src/services/template-package/TemplatePackageManifest';
import { replaceFileWithPlatformCompatibility } from './file-replacement';

const MODEL_EXTENSIONS = new Map<string, 'gpt' | 'sovits'>([['.ckpt', 'gpt'], ['.pth', 'sovits']]);
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac']);
const SKIPPED_DIRECTORIES = new Set([
  'runtime', 'tools', 'pretrained_models', 'pretrained', 'node_modules', '__pycache__',
  '.git', '.cache', 'cache', 'caches', 'tmp', 'temp', 'logs', 'presets',
]);

export function registerVoiceAuthoringHandlers(): void {
  void cleanupStaleVoiceSessions();
  ipcMain.handle('voiceAuthoring:scanCatalog', (_event, request: ScanVoiceCatalogRequest) => scanVoiceCatalog(request));
  ipcMain.handle('voiceAuthoring:pickReferenceAudio', async (event, multiple: boolean) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow) return [];
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: multiple ? '选择辅助参考音频' : '选择参考音频',
      filters: [{ name: '音频文件', extensions: [...AUDIO_EXTENSIONS].map((extension) => extension.slice(1)) }],
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('voiceAuthoring:listPresets', () => readLibraryResult());
  ipcMain.handle('voiceAuthoring:resolveReference', async (_event, presetId: string, referenceId: string) => {
    try {
      const preset = (await readLibrary()).presets.find((item) => item.id === presetId);
      const reference = preset?.references.find((item) => item.id === referenceId);
      if (!reference) throw new Error('托管参考音频不存在。');
      return { success: true, absolutePath: resolveManagedPath(reference.managedPath) };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });
  ipcMain.handle('voiceAuthoring:savePreset', (_event, request: SaveLocalVoicePresetRequest) => savePreset(request));
  ipcMain.handle('voiceAuthoring:renamePreset', (_event, presetId: string, name: string) => mutatePreset(presetId, (preset) => ({
    ...preset,
    name: cleanRequiredText(name, '音色名称'),
    updatedAt: new Date().toISOString(),
  })));
  ipcMain.handle('voiceAuthoring:duplicatePreset', (_event, presetId: string, name?: string) => duplicatePreset(presetId, name));
  ipcMain.handle('voiceAuthoring:deletePreset', (_event, presetId: string) => deletePreset(presetId));
  ipcMain.handle('voiceAuthoring:publishTemplateProfile', (_event, presetId: string) => publishTemplateProfile(presetId));
  ipcMain.handle('voiceAuthoring:clearSession', (_event, sessionId: string) => clearSession(sessionId));
}

export async function scanVoiceCatalog(request: ScanVoiceCatalogRequest): Promise<VoiceCatalogResult> {
  const maxEntries = Math.min(Math.max(request.maxEntries ?? 4000, 1), 10000);
  const deadline = Date.now() + Math.min(Math.max(request.maxDurationMs ?? 5000, 100), 30000);
  const models: VoiceCatalogModel[] = [];
  const references: VoiceCatalogReference[] = [];
  const issues: VoiceCatalogIssue[] = [];
  const visited = new Set<string>();
  let truncated = false;
  let timedOut = false;
  let entryLimitReached = false;

  const consumeBudget = () => {
    if (Date.now() >= deadline) {
      truncated = true;
      timedOut = true;
      return false;
    }
    if (models.length + references.length >= maxEntries) {
      truncated = true;
      entryLimitReached = true;
      return false;
    }
    return true;
  };

  const scan = async (root: string, mode: 'models' | 'references', standardRoot = false): Promise<void> => {
    const cleanRoot = root?.trim();
    if (!cleanRoot) return;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(cleanRoot);
    } catch (error: any) {
      issues.push({ code: 'missing-root', root: cleanRoot, message: error?.message || '目录不存在。' });
      return;
    }
    if (!stat.isDirectory()) {
      issues.push({ code: 'invalid-entry', root: cleanRoot, message: '扫描根不是目录。' });
      return;
    }
    await walk(cleanRoot, cleanRoot, mode, standardRoot);
  };

  const walk = async (root: string, directory: string, mode: 'models' | 'references', standardRoot: boolean): Promise<void> => {
    if (!consumeBudget()) return;
    let real: string;
    try {
      real = await fs.promises.realpath(directory);
    } catch (error: any) {
      issues.push({ code: 'unreadable-root', root: directory, message: error?.message || '无法解析目录。' });
      return;
    }
    const realKey = `${mode}:${normalizeCase(real)}`;
    if (visited.has(realKey)) return;
    visited.add(realKey);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error: any) {
      issues.push({ code: 'unreadable-root', root: directory, message: error?.message || '无法读取目录。' });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!consumeBudget()) return;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIPPED_DIRECTORIES.has(lower)) continue;
        if (standardRoot && directory === root && !/^GPT_weights/i.test(entry.name) && !/^SoVITS_weights/i.test(entry.name)) continue;
        await walk(root, absolutePath, mode, standardRoot);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (mode === 'models') {
        const kind = MODEL_EXTENSIONS.get(extension);
        if (!kind) continue;
        const stats = await safeStat(absolutePath);
        models.push({
          kind,
          absolutePath,
          fileName: entry.name,
          relativePathSuffix: relativeSuffix(root, absolutePath),
          sourceRoot: root,
          size: stats?.size,
          modifiedAt: stats?.mtimeMs,
        });
      } else if (AUDIO_EXTENSIONS.has(extension)) {
        const stats = await safeStat(absolutePath);
        references.push({
          absolutePath,
          fileName: entry.name,
          sourceRoot: root,
          pathTags: path.relative(root, path.dirname(absolutePath)).split(path.sep).filter(Boolean),
          transcriptTrusted: false,
          size: stats?.size,
          modifiedAt: stats?.mtimeMs,
        });
      }
    }
  };

  if (request.gptRoot?.trim()) await scan(request.gptRoot, 'models', true);
  for (const root of uniqueRoots(request.modelRoots)) await scan(root, 'models');
  for (const root of uniqueRoots(request.referenceRoots)) await scan(root, 'references');
  if (entryLimitReached) issues.push({ code: 'limit-reached', root: '', message: `扫描结果已限制为 ${maxEntries} 项。` });
  if (timedOut) issues.push({ code: 'time-limit-reached', root: '', message: '目录扫描达到时间上限，已返回当前结果。' });

  return {
    models: stableUnique(models, (item) => normalizeCase(item.absolutePath)),
    references: stableUnique(references, (item) => normalizeCase(item.absolutePath)),
    issues,
    truncated,
  };
}

export async function savePreset(request: SaveLocalVoicePresetRequest) {
  let stagingDirectory = '';
  let backupDirectory = '';
  let finalDirectory = '';
  let referencesSwapped = false;
  try {
    const library = await readLibrary();
    const now = new Date().toISOString();
    const requestedId = cleanId(request.preset.id);
    const id = request.mode === 'save-as' ? await uniquePresetId(library, requestedId) : requestedId;
    const existingIndex = library.presets.findIndex((preset) => preset.id === id);
    if (request.mode === 'create' && existingIndex >= 0) throw new Error('音色 ID 已存在。');
    if (request.mode === 'update' && existingIndex < 0) throw new Error('要更新的音色不存在。');

    const preset: LocalVoicePreset = {
      ...request.preset,
      id,
      createdAt: existingIndex >= 0 ? library.presets[existingIndex].createdAt : request.preset.createdAt || now,
      updatedAt: now,
      references: request.preset.references.map((reference) => ({ ...reference })),
    };
    const preflightError = validateLocalVoicePreset(preset);
    if (preflightError && !preflightError.includes('尚未进入托管语音库')) throw new Error(preflightError);
    if ((request.references?.length ?? 0) > 0) {
      finalDirectory = path.join(getLibraryRoot(), 'references', id);
      stagingDirectory = `${finalDirectory}.staging-${process.pid}-${Date.now()}`;
      backupDirectory = `${finalDirectory}.backup-${process.pid}`;
      assertInside(getLibraryRoot(), stagingDirectory);
      await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
      await fs.promises.rm(backupDirectory, { recursive: true, force: true });
      if (fs.existsSync(finalDirectory)) await fs.promises.cp(finalDirectory, stagingDirectory, { recursive: true });
      else await fs.promises.mkdir(stagingDirectory, { recursive: true });
      for (const source of request.references ?? []) {
        const reference = preset.references.find((item) => item.id === source.referenceId);
        if (!reference) throw new Error(`参考音频不存在：${source.referenceId}`);
        reference.managedPath = await copyReferenceToPresetDirectory(id, reference.id, source.sourcePath, stagingDirectory);
      }
    }
    const validationError = validateLocalVoicePreset(preset);
    if (validationError) throw new Error(validationError);
    if (existingIndex >= 0) library.presets[existingIndex] = preset;
    else library.presets.push(preset);
    if (stagingDirectory) {
      if (fs.existsSync(finalDirectory)) await fs.promises.rename(finalDirectory, backupDirectory);
      await fs.promises.rename(stagingDirectory, finalDirectory);
      referencesSwapped = true;
    }
    try {
      await writeLibrary(library);
    } catch (error) {
      if (referencesSwapped) {
        await fs.promises.rm(finalDirectory, { recursive: true, force: true }).catch(() => {});
        if (fs.existsSync(backupDirectory)) await fs.promises.rename(backupDirectory, finalDirectory).catch(() => {});
      }
      throw error;
    }
    if (backupDirectory) await fs.promises.rm(backupDirectory, { recursive: true, force: true });
    return { success: true, preset };
  } catch (error: any) {
    if (stagingDirectory) await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    if (backupDirectory && fs.existsSync(backupDirectory) && !fs.existsSync(finalDirectory)) {
      await fs.promises.rename(backupDirectory, finalDirectory).catch(() => {});
    }
    return { success: false, error: error?.message || String(error) };
  }
}

async function mutatePreset(presetId: string, update: (preset: LocalVoicePreset) => LocalVoicePreset) {
  try {
    const library = await readLibrary();
    const index = library.presets.findIndex((preset) => preset.id === presetId);
    if (index < 0) throw new Error('音色配置不存在。');
    const next = update(library.presets[index]);
    const validationError = validateLocalVoicePreset(next);
    if (validationError) throw new Error(validationError);
    library.presets[index] = next;
    await writeLibrary(library);
    return { success: true, preset: next };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

async function duplicatePreset(presetId: string, name?: string) {
  try {
    const library = await readLibrary();
    const source = library.presets.find((preset) => preset.id === presetId);
    if (!source) throw new Error('音色配置不存在。');
    const id = await uniquePresetId(library, `${source.id}-copy`);
    const now = new Date().toISOString();
    const references = await Promise.all(source.references.map(async (reference) => {
      const sourceAbsolute = resolveManagedPath(reference.managedPath);
      const managedPath = await copyManagedReference(id, reference.id, sourceAbsolute);
      return { ...reference, managedPath };
    }));
    const preset = { ...source, id, name: name?.trim() || `${source.name} 副本`, references, createdAt: now, updatedAt: now };
    library.presets.push(preset);
    await writeLibrary(library);
    return { success: true, preset };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

export async function deletePreset(presetId: string) {
  try {
    const library = await readLibrary();
    const index = library.presets.findIndex((preset) => preset.id === presetId);
    if (index < 0) throw new Error('音色配置不存在。');
    const referenceDirectory = path.join(getLibraryRoot(), 'references', cleanId(presetId));
    assertInside(getLibraryRoot(), referenceDirectory);
    await fs.promises.rm(referenceDirectory, { recursive: true, force: true });
    library.presets.splice(index, 1);
    await writeLibrary(library);
    return { success: true, library };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

export async function publishTemplateProfile(presetId: string) {
  try {
    const preset = (await readLibrary()).presets.find((item) => item.id === presetId);
    if (!preset) throw new Error('音色配置不存在。');
    const packageRoot = path.join(app.getPath('userData'), 'templates', 'aeonstagery.user-voices');
    const manifestPath = path.join(packageRoot, 'manifest.json');
    const stagingRoot = `${packageRoot}.staging-${process.pid}-${Date.now()}`;
    const backupRoot = `${packageRoot}.backup-${process.pid}`;
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    await fs.promises.rm(backupRoot, { recursive: true, force: true });
    if (fs.existsSync(packageRoot)) await fs.promises.cp(packageRoot, stagingRoot, { recursive: true });
    else await fs.promises.mkdir(stagingRoot, { recursive: true });
    const existing = await readJsonIfExists(manifestPath);
    const manifest: any = existing ?? {
      template: { id: 'aeonstagery.user-voices', name: 'User Voice Profiles', version: '1.0.0', category: 'voice' },
      assets: { root: 'assets', index: [] },
      voiceProfiles: [],
    };
    manifest.assets ??= { root: 'assets', index: [] };
    manifest.assets.root ??= 'assets';
    manifest.assets.index = Array.isArray(manifest.assets.index) ? manifest.assets.index : [];
    manifest.voiceProfiles = Array.isArray(manifest.voiceProfiles) ? manifest.voiceProfiles : [];

    const templateReferences = [];
    for (const reference of preset.references) {
      const source = resolveManagedPath(reference.managedPath);
      const extension = path.extname(source).toLowerCase();
      const assetId = `voice.${preset.id}.${reference.id}`;
      const assetPath = `voice/${cleanId(preset.id)}/${cleanId(reference.id)}${extension}`;
      const target = path.join(stagingRoot, manifest.assets.root, assetPath);
      assertInside(stagingRoot, target);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.copyFile(source, target);
      manifest.assets.index = manifest.assets.index.filter((asset: any) => asset?.id !== assetId);
      manifest.assets.index.push({ id: assetId, path: assetPath, kind: 'audio', label: reference.label });
      templateReferences.push({
        id: reference.id, label: reference.label, assetId, role: reference.role,
        promptText: reference.promptText, promptLang: reference.promptLang, tags: reference.tags,
      });
    }
    const profile = {
      id: preset.id,
      name: preset.name,
      gptModel: createModelSelector(preset.gptModel),
      sovitsModel: createModelSelector(preset.sovitsModel),
      references: templateReferences,
      inferenceDefaults: { ...preset.inferenceDefaults },
    };
    manifest.voiceProfiles = manifest.voiceProfiles.filter((item: any) => item?.id !== preset.id);
    manifest.voiceProfiles.push(profile);
    try {
      parseTemplatePackageManifest(manifest);
      await writeJsonAtomic(path.join(stagingRoot, 'manifest.json'), manifest);
    } catch (error) {
      await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    let movedExisting = false;
    try {
      if (fs.existsSync(packageRoot)) {
        await fs.promises.rename(packageRoot, backupRoot);
        movedExisting = true;
      }
      await fs.promises.rename(stagingRoot, packageRoot);
      await fs.promises.rm(backupRoot, { recursive: true, force: true });
    } catch (error) {
      if (movedExisting && !fs.existsSync(packageRoot) && fs.existsSync(backupRoot)) {
        await fs.promises.rename(backupRoot, packageRoot).catch(() => {});
      }
      await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { success: true, templateId: manifest.template.id, profileId: preset.id, manifestPath };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

async function clearSession(sessionId: string) {
  try {
    const target = path.join(getWorkbenchRoot(), cleanId(sessionId));
    assertInside(getWorkbenchRoot(), target);
    await fs.promises.rm(target, { recursive: true, force: true });
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

async function readLibraryResult() {
  try {
    return { success: true, library: await readLibrary() };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

export async function readLibrary(): Promise<VoiceLibraryDocument> {
  const libraryPath = path.join(getLibraryRoot(), 'library.json');
  try {
    const parsed = JSON.parse(await fs.promises.readFile(libraryPath, 'utf8'));
    if (parsed?.schemaVersion !== VOICE_LIBRARY_SCHEMA_VERSION || !Array.isArray(parsed.presets)) {
      throw new Error('用户语音库 schemaVersion 不受支持。');
    }
    return { schemaVersion: VOICE_LIBRARY_SCHEMA_VERSION, presets: parsed.presets };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { schemaVersion: VOICE_LIBRARY_SCHEMA_VERSION, presets: [] };
    throw error;
  }
}

async function writeLibrary(library: VoiceLibraryDocument): Promise<void> {
  const root = getLibraryRoot();
  await fs.promises.mkdir(root, { recursive: true });
  const target = path.join(root, 'library.json');
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(library, null, 2), 'utf8');
  try {
    await replaceFileWithPlatformCompatibility(temp, target);
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJsonIfExists(filePath: string): Promise<any | null> {
  try { return JSON.parse(await fs.promises.readFile(filePath, 'utf8')); }
  catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  try { await replaceFileWithPlatformCompatibility(temp, target); }
  catch (error) { await fs.promises.rm(temp, { force: true }).catch(() => {}); throw error; }
}

async function copyManagedReference(presetId: string, referenceId: string, sourcePath: string): Promise<string> {
  const targetDirectory = path.join(getLibraryRoot(), 'references', cleanId(presetId));
  return copyReferenceToPresetDirectory(presetId, referenceId, sourcePath, targetDirectory);
}

async function copyReferenceToPresetDirectory(presetId: string, referenceId: string, sourcePath: string, targetDirectory: string): Promise<string> {
  const extension = path.extname(sourcePath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) throw new Error('参考文件不是支持的音频格式。');
  const relative = path.join('references', cleanId(presetId), `${cleanId(referenceId)}${extension}`);
  const target = path.join(targetDirectory, `${cleanId(referenceId)}${extension}`);
  assertInside(getLibraryRoot(), target);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(sourcePath, target);
  return relative.replace(/\\/g, '/');
}

function resolveManagedPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error('语音库引用必须是相对路径。');
  const absolute = path.resolve(getLibraryRoot(), relativePath);
  assertInside(getLibraryRoot(), absolute);
  return absolute;
}

function getLibraryRoot(): string { return path.join(app.getPath('userData'), 'voice-library'); }
export function getWorkbenchRoot(): string { return path.join(app.getPath('userData'), 'voice-workbench'); }

export async function cleanupStaleVoiceSessions(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  const root = getWorkbenchRoot();
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(async (entry) => {
    const target = path.join(root, entry.name);
    const stats = await safeStat(target);
    if (stats && stats.mtimeMs < cutoff) await fs.promises.rm(target, { recursive: true, force: true });
  }));
}

export function clearAllVoiceSessionsSync(): void {
  const root = getWorkbenchRoot();
  assertInside(app.getPath('userData'), root);
  fs.rmSync(root, { recursive: true, force: true });
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (relative) throw new Error('路径超出 AeonStagery 托管语音目录。');
  }
}

function cleanId(value: string): string {
  const clean = value?.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!clean) throw new Error('无效的 ID。');
  return clean;
}

function cleanRequiredText(value: string, label: string): string {
  const clean = value?.trim();
  if (!clean) throw new Error(`${label}不能为空。`);
  return clean;
}

async function uniquePresetId(library: VoiceLibraryDocument, base: string): Promise<string> {
  const cleanBase = cleanId(base);
  const used = new Set(library.presets.map((preset) => preset.id));
  if (!used.has(cleanBase)) return cleanBase;
  for (let index = 2; index < 10000; index += 1) {
    if (!used.has(`${cleanBase}-${index}`)) return `${cleanBase}-${index}`;
  }
  throw new Error('无法分配新的音色 ID。');
}

function relativeSuffix(root: string, filePath: string): string | undefined {
  const relative = path.relative(root, filePath).replace(/\\/g, '/');
  return relative && relative !== path.basename(filePath) ? relative : undefined;
}

function normalizeCase(value: string): string { return path.resolve(value).replace(/\\/g, '/').toLowerCase(); }
function uniqueRoots(roots: string[] | undefined): string[] { return stableUnique((roots ?? []).filter((root) => root?.trim()), normalizeCase); }
function stableUnique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => { const value = key(item); if (seen.has(value)) return false; seen.add(value); return true; });
}
async function safeStat(filePath: string): Promise<fs.Stats | undefined> {
  try { return await fs.promises.stat(filePath); } catch { return undefined; }
}
