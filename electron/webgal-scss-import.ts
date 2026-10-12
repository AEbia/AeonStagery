/**
 * In-app import of a WebGAL dialogue template.
 *
 * The conversion itself lives in `src/services/import/webgal/` and is pure; this
 * module is the filesystem half: reading the template directory, checking the
 * result against what is already installed, and writing the package into the
 * user's template library with the same staging-and-verify discipline as the
 * `.zip` importer.
 *
 * Intentionally free of Electron imports so it can be unit tested directly — the
 * IPC layer supplies the library root and owns the dialogs.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ImportedTemplatePackageSummary,
  WebGalScssImportConflict,
  WebGalScssImportInspection,
} from '../src/api/types/template-package-import';
import { TemplatePackageLoader } from '../src/services/template-package/TemplatePackageLoader';
import { parseTemplatePackageManifest } from '../src/services/template-package/TemplatePackageManifest';
import {
  buildWebGalTextboxTemplatePackage,
  WEBGAL_PACKAGE_ASSET_ROOT,
  type WebGalTemplatePackageBuild,
} from '../src/services/import/webgal/WebGalTextboxScssPackage';
import {
  findWebGalImportConflicts,
  scssContentHash,
  slugifyWebGalPackageName,
  uniquePackageName,
  WEBGAL_IMPORT_RECORD_FILE,
  WEBGAL_PACKAGE_ID_PREFIX,
  dialogueParamsSignature,
  type WebGalImportRecord,
} from '../src/services/import/webgal/WebGalScssPackageNaming';
import { extractWebGalTextBoxTheme } from '../src/services/import/webgal/WebGalTextboxScssTranslator';
import { parseBlocks, urlBasename } from '../src/services/import/webgal/WebGalScssSyntax';

/** Stylesheet the dialogue panel is authored in. */
const TEXTBOX_STYLESHEET = path.join('Stage', 'TextBox', 'textbox.scss');

/** Description used when the caller does not supply one. */
function defaultDescription(templateName: string): string {
  return `Imported from the WebGAL template "${templateName}" (Stage/TextBox/textbox.scss).`;
}

export interface WebGalScssInspectInput {
  /** WebGAL template directory (the one holding `template.json`). */
  templateRoot: string;
  /** Directory the editor installs user template packages into. */
  templatesRoot: string;
}

export interface WebGalScssInstallInput extends WebGalScssInspectInput {
  /** Final display name; sanitised and de-duplicated here as well. */
  packageName?: string;
  /** Final package id; derived from the display name when omitted. */
  packageId?: string;
  styleId?: string;
  styleName?: string;
  /**
   * Replace this already-installed package instead of adding another one.
   *
   * The package id and dialogue style id are kept, so scenes that already
   * reference the style keep working after the import.
   */
  replacePackageId?: string;
  version?: string;
  author?: string;
}

export class WebGalTemplateAlreadyInstalledError extends Error {
  constructor(
    readonly packageId: string,
    readonly packageName: string,
    readonly conflicts: readonly WebGalScssImportConflict[],
  ) {
    super(`模板已存在：${packageName}`);
  }
}

interface InstalledPackageRecord {
  packageId: string;
  packageName: string;
  /** The directory the manifest was actually read from. */
  packageRoot: string;
  /** Style ids the package defines, so a replace can keep the ones in use. */
  styleIds: string[];
  record: WebGalImportRecord | null;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent<T>(targetPath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.promises.readFile(targetPath, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Reject a path that would escape the directory it is supposed to live in. */
function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(root, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`路径越过目标目录：${relativePath}`);
  }
  return resolvedPath;
}

/** Locate `Stage/TextBox/textbox.scss`, accepting the stylesheet path itself. */
export function resolveWebGalTemplateRoot(input: string): string {
  const resolved = path.resolve(input);
  if (path.basename(resolved).toLowerCase() === 'textbox.scss') {
    const root = path.dirname(path.dirname(path.dirname(resolved)));
    if (fs.existsSync(path.join(root, TEXTBOX_STYLESHEET))) return root;
    throw new Error(`无法从 ${input} 定位 Stage/TextBox/textbox.scss`);
  }
  if (!fs.existsSync(path.join(resolved, TEXTBOX_STYLESHEET))) {
    throw new Error(`该目录中没有 Stage/TextBox/textbox.scss：${input}`);
  }
  return resolved;
}

async function readTemplateName(templateRoot: string): Promise<string> {
  const raw = await readJsonIfPresent<{ name?: unknown }>(path.join(templateRoot, 'template.json'));
  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  return name || path.basename(templateRoot);
}

/** Font declared by `template.json`, when it ships one the editor can load. */
async function readTemplateFont(templateRoot: string) {
  const raw = await readJsonIfPresent<{ fonts?: unknown }>(path.join(templateRoot, 'template.json'));
  const fonts = raw?.fonts;
  if (!Array.isArray(fonts)) return null;
  for (const entry of fonts) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const family = typeof record['font-family'] === 'string' ? record['font-family'].trim() : '';
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!family || !url) continue;
    // WebGAL also ships a pre-compressed copy for its own transfer path.
    if (/\.gz$/i.test(url)) continue;
    const sourcePath = resolveInside(templateRoot, url);
    if (await pathExists(sourcePath)) return { family, sourcePath };
  }
  return null;
}

/** Read the `::after` ornaments the theme references so they can be inlined. */
async function readDecorationSources(templateRoot: string, scss: string) {
  const theme = extractWebGalTextBoxTheme(parseBlocks(scss));
  const sources: { textbox?: string | null; namebox?: string | null } = {};
  for (const slot of ['textbox', 'namebox'] as const) {
    const file = theme[slot].deco?.file;
    if (!file) continue;
    // The translator already reduced `url(...)` to a file name.
    const name = urlBasename(file) ?? file;
    const candidate = resolveInside(path.join(templateRoot, 'assets'), name);
    sources[slot] = await fs.promises.readFile(candidate, 'utf8').catch(() => null);
  }
  return sources;
}

async function convertTemplate(input: WebGalScssInspectInput & {
  packageId: string;
  packageName: string;
  styleId: string;
  styleName: string;
  version?: string;
  author?: string;
}): Promise<{ build: WebGalTemplatePackageBuild; sourceHash: string; sourceName: string }> {
  const templateRoot = resolveWebGalTemplateRoot(input.templateRoot);
  const stylesheetPath = path.join(templateRoot, TEXTBOX_STYLESHEET);
  const scss = await fs.promises.readFile(stylesheetPath, 'utf8');
  const font = await readTemplateFont(templateRoot);
  const decoSources = await readDecorationSources(templateRoot, scss);

  const build = buildWebGalTextboxTemplatePackage({
    scss,
    templateId: input.packageId,
    templateName: input.packageName,
    sourceName: path.basename(stylesheetPath),
    styleId: input.styleId,
    styleName: input.styleName,
    version: input.version,
    author: input.author,
    description: defaultDescription(input.packageName),
    font,
    decoSources,
  });

  return { build, sourceHash: scssContentHash(scss), sourceName: path.basename(stylesheetPath) };
}

/** Read what is already installed, so conflicts and free names can be reported. */
async function scanInstalledPackages(templatesRoot: string): Promise<InstalledPackageRecord[]> {
  const records: InstalledPackageRecord[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(templatesRoot, { withFileTypes: true });
  } catch {
    return records;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const packageRoot = path.join(templatesRoot, entry.name);
    const manifest = await readJsonIfPresent<Record<string, any>>(
      path.join(packageRoot, 'manifest.v2.json'),
    );
    if (!manifest) continue;

    const sidecar = await readJsonIfPresent<WebGalImportRecord>(
      path.join(packageRoot, WEBGAL_IMPORT_RECORD_FILE),
    );
    const styleParams = (manifest.dialogueStyles ?? [])
      .map((style: Record<string, unknown>) => style?.params)
      .filter(Boolean);

    records.push({
      packageId: String(manifest.template?.id ?? entry.name),
      packageName: String(manifest.template?.name ?? entry.name),
      // Discovery does not require the directory to be named after the package
      // id (`--out` can differ), so remember where the manifest actually lives.
      packageRoot,
      // A package id and its style id are not the same thing (`--style-id`), so
      // a replace has to keep the ids the installed styles were published under.
      styleIds: (Array.isArray(manifest.dialogueStyles) ? manifest.dialogueStyles : [])
        .map((style: Record<string, unknown>) => String(style?.id ?? ''))
        .filter(Boolean),
      // The sidecar records the original stylesheet hash; without it a package
      // can still be matched on the parameters it translates to.
      record: {
        ...(sidecar ?? {}),
        ...(styleParams.length
          ? { paramsSignature: dialogueParamsSignature(styleParams[0]) }
          : {}),
      },
    });
  }
  return records;
}

/** What a caller learns before anything is written to disk. */
export async function inspectWebGalTemplateDirectory(
  input: WebGalScssInspectInput,
): Promise<WebGalScssImportInspection> {
  const templateRoot = resolveWebGalTemplateRoot(input.templateRoot);
  const templateName = await readTemplateName(templateRoot);
  const installed = await scanInstalledPackages(input.templatesRoot);

  const desiredName = templateName;
  const packageName = uniquePackageName(desiredName, installed.map((entry) => entry.packageName));
  const packageId = uniquePackageName(
    `${WEBGAL_PACKAGE_ID_PREFIX}${slugifyWebGalPackageName(desiredName)}`,
    installed.map((entry) => entry.packageId),
  );

  const { build, sourceHash, sourceName } = await convertTemplate({
    ...input,
    templateRoot,
    packageName,
    packageId,
    styleId: packageId,
    styleName: desiredName,
  });

  const paramsSignature = dialogueParamsSignature(build.style.params);
  const conflicts = findWebGalImportConflicts(
    { sourceHash, paramsSignature },
    installed.map((entry) => ({
      packageId: entry.packageId,
      packageName: entry.packageName,
      record: entry.record,
    })),
  );

  return {
    templateRoot,
    templateName,
    packageName,
    packageId,
    styleId: build.style.id,
    styleName: build.style.name,
    sourceName,
    sourceHash,
    paramsSignature,
    conflicts,
    unverifiableCount: installed.filter((entry) => !entry.record?.sourceHash).length,
    takenPackageNames: installed.map((entry) => entry.packageName),
    notes: build.notes,
  };
}

/**
 * Write the package into the template library.
 *
 * The build is recomputed from the source rather than carried over from
 * inspection, which keeps the IPC surface stateless: a retry after a failed
 * write, or after the user changed their mind, re-reads the template and cannot
 * install a stale conversion.
 */
export async function installWebGalTemplatePackage(
  input: WebGalScssInstallInput,
): Promise<ImportedTemplatePackageSummary> {
  const templateRoot = resolveWebGalTemplateRoot(input.templateRoot);
  const installed = await scanInstalledPackages(input.templatesRoot);

  const replaceTarget = input.replacePackageId
    ? installed.find((entry) => entry.packageId === input.replacePackageId) ?? null
    : null;
  if (input.replacePackageId && !replaceTarget) {
    throw new Error(`要覆盖的模板不存在：${input.replacePackageId}`);
  }

  // Replacing keeps the existing id and style id so scenes referencing the style
  // keep resolving; a fresh import gets a name and id that are still free.
  const packageName = replaceTarget
    ? replaceTarget.packageName
    : uniquePackageName(
        String(input.packageName ?? '').trim() || await readTemplateName(templateRoot),
        installed.map((entry) => entry.packageName),
      );
  const packageId = replaceTarget
    ? replaceTarget.packageId
    : uniquePackageName(
        String(input.packageId ?? '').trim()
          || `${WEBGAL_PACKAGE_ID_PREFIX}${slugifyWebGalPackageName(packageName)}`,
        installed.map((entry) => entry.packageId),
      );

  // A package id and a style id may legitimately differ (`--style-id`), so the
  // requested one wins; replacing falls back to the id the installed package
  // already uses, because scenes reference the style rather than the package.
  const requestedStyleId = String(input.styleId ?? '').trim();

  const { build, sourceHash, sourceName } = await convertTemplate({
    ...input,
    templateRoot,
    packageName,
    packageId,
    styleId: requestedStyleId
      || (replaceTarget ? replaceTarget.styleIds[0] ?? packageId : packageId),
    styleName: String(input.styleName ?? '').trim() || packageName,
  });

  // Replace into the directory the package was actually found in. Deriving it
  // from the package id instead would create a second directory — and a second
  // package claiming the same id — whenever the installed one has another name.
  const destinationRoot = replaceTarget
    ? replaceTarget.packageRoot
    : resolveInside(input.templatesRoot, packageId);
  const alreadyExists = await pathExists(destinationRoot);
  if (alreadyExists && !replaceTarget) {
    throw new WebGalTemplateAlreadyInstalledError(packageId, packageName, []);
  }

  await fs.promises.mkdir(input.templatesRoot, { recursive: true });
  const nonce = crypto.randomUUID();
  const stagingRoot = path.join(input.templatesRoot, `.import-${nonce}`);
  const backupRoot = path.join(input.templatesRoot, `.backup-${packageId}-${nonce}`);
  let movedExisting = false;
  try {
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    for (const file of build.files) {
      const target = resolveInside(stagingRoot, file.relativePath);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      if (file.sourcePath) {
        // The font is copied from the template; refuse anything pointing outside it.
        resolveInside(templateRoot, path.relative(templateRoot, file.sourcePath));
        await fs.promises.copyFile(file.sourcePath, target);
        continue;
      }
      await fs.promises.writeFile(target, file.contents ?? '', 'utf8');
    }

    const record: WebGalImportRecord = {
      sourcePath: templateRoot,
      sourceName,
      sourceHash,
      paramsSignature: dialogueParamsSignature(build.style.params),
      importedAt: new Date().toISOString(),
      styleIds: [build.style.id],
    };
    await fs.promises.writeFile(
      path.join(stagingRoot, WEBGAL_IMPORT_RECORD_FILE),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );

    // Load what was written before replacing anything: a package the engine
    // rejects must never reach the library.
    const staged = await new TemplatePackageLoader({
      readFile: async (filePath: string) => ({ path: filePath, data: await fs.promises.readFile(filePath, 'utf8') }),
      join: async (...parts: string[]) => path.join(...parts),
      dirname: async (filePath: string) => path.dirname(filePath),
    }).loadFromPackageRoot('user', stagingRoot);
    if (staged.manifest.template.id !== packageId) {
      throw new Error('写入后的模板清单与预期不一致');
    }
    await validatePanelAssets(stagingRoot, staged.manifest);
    parseTemplatePackageManifest(staged.manifest);

    if (alreadyExists) {
      await fs.promises.rename(destinationRoot, backupRoot);
      movedExisting = true;
    }
    await fs.promises.rename(stagingRoot, destinationRoot);
    if (movedExisting) await fs.promises.rm(backupRoot, { recursive: true, force: true });

    return {
      id: packageId,
      name: packageName,
      version: build.manifest.template.version,
      installPath: destinationRoot,
      replaced: alreadyExists,
    };
  } catch (error) {
    if (movedExisting && !(await pathExists(destinationRoot)) && await pathExists(backupRoot)) {
      await fs.promises.rename(backupRoot, destinationRoot);
    }
    throw error;
  } finally {
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    if (!movedExisting || await pathExists(destinationRoot)) {
      await fs.promises.rm(backupRoot, { recursive: true, force: true });
    }
  }
}

/**
 * Confirm the artwork a style references is actually present.
 *
 * `manifest.dialogueStyles[].params.textbox.image` is neither an `assets/…`
 * reference (so the archive importer's check skips it) nor validated by the
 * manifest parser — a wrong path only shows up as an ENOENT when the style is
 * applied to a line.
 */
async function validatePanelAssets(
  packageRoot: string,
  manifest: ReturnType<typeof parseTemplatePackageManifest>,
): Promise<void> {
  const assetRoot = manifest.assets?.root ?? WEBGAL_PACKAGE_ASSET_ROOT;
  for (const style of manifest.dialogueStyles ?? []) {
    const params = style.params as Record<string, any> | undefined;
    const references = [
      params?.textbox?.image,
      params?.namebox?.image,
      params?.text?.fontFile,
      params?.speaker?.fontFile,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    for (const reference of references) {
      const target = resolveInside(packageRoot, path.posix.join(assetRoot, reference.replace(/\\/g, '/')));
      const stats = await fs.promises.stat(target).catch(() => null);
      if (!stats?.isFile()) {
        throw new Error(`模板样式引用的素材缺失：${style.id} → ${reference}`);
      }
    }
  }
}
