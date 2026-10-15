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
  /** Files referenced by the installed style, including old content-hashed SVGs. */
  assetFiles: string[];
  /**
   * Whether a wholesale replace is safe. An import reproduces a single dialogue
   * style, so replacing a package that publishes several would drop the rest —
   * their definitions and the assets only they reference.
   */
  replaceable: boolean;
  /** Whether the package has the artwork path emitted by this WebGAL importer. */
  hasWebGalGeneratedArtwork: boolean;
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

/** Check the actual file location as well as the declared path. */
async function validateTemplateFile(templateRoot: string, sourcePath: string): Promise<void> {
  resolveInside(templateRoot, path.relative(templateRoot, sourcePath));
  const [realRoot, realSource] = await Promise.all([
    fs.promises.realpath(templateRoot),
    fs.promises.realpath(sourcePath),
  ]);
  resolveInside(realRoot, path.relative(realRoot, realSource));
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
    if (await pathExists(sourcePath)) {
      await validateTemplateFile(templateRoot, sourcePath);
      return { family, sourcePath };
    }
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

/**
 * Manifest keys that describe a capability this import does not reproduce.
 *
 * A replace rewrites the whole directory, so anything the new manifest will not
 * declare disappears — camera presets, voice profiles and the rest are authored
 * by hand or by other importers and have no equivalent here. `dialogueStyles` is
 * what this import writes; `assets` only names the root the artwork lives in,
 * and the generated files are compared on disk instead.
 */
const IMPORTED_CAPABILITIES = new Set(['dialogueStyles', 'assets', 'template', 'manifestSchemaVersion', 'v']);

function unimportedCapabilities(manifest: Record<string, unknown>): string[] {
  return Object.keys(manifest).filter((key) => !IMPORTED_CAPABILITIES.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Use the installed manifest's resource records rather than the new build's hashes. */
function installedAssetFiles(
  packageRoot: string,
  manifest: Record<string, unknown>,
  styles: Record<string, unknown>[],
): string[] {
  const assetRoot = isRecord(manifest.assets) && typeof manifest.assets.root === 'string'
    ? manifest.assets.root : WEBGAL_PACKAGE_ASSET_ROOT;
  const files: string[] = [];
  for (const style of styles) {
    if (!isRecord(style.params)) continue;
    for (const [slot, resource] of [
      ['textbox', 'image'], ['namebox', 'image'], ['text', 'fontFile'], ['speaker', 'fontFile'],
    ]) {
      const params = style.params[slot];
      const relative = isRecord(params) ? params[resource] : null;
      if (typeof relative !== 'string' || !relative) continue;
      const target = resolveInside(packageRoot, path.join(assetRoot, relative));
      files.push(path.relative(packageRoot, target).split(path.sep).join('/'));
    }
  }
  return files;
}

/**
 * Older WebGAL imports may not have a sidecar yet. Only count packages that
 * carry this importer's generated panel artwork as candidates for that legacy
 * format; ordinary image dialogue styles (including the bundled ones) also
 * lack sidecars, but were never imported from WebGAL.
 */
function hasWebGalGeneratedArtwork(styles: Record<string, unknown>[]): boolean {
  const generatedPanelPath = (style: Record<string, unknown>, slot: 'textbox' | 'namebox') => {
    if (!isRecord(style.params)) return false;
    const panel = style.params[slot];
    if (!isRecord(panel) || typeof panel.image !== 'string') return false;
    return panel.image.replace(/\\/g, '/').startsWith('ui/dialogue/webgal/');
  };
  return styles.some((style) => generatedPanelPath(style, 'textbox') && generatedPanelPath(style, 'namebox'));
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
    try {
      const manifest = await readJsonIfPresent<unknown>(
        path.join(packageRoot, 'manifest.v2.json'),
      );
      if (!isRecord(manifest) || !isRecord(manifest.template)) continue;
      if (manifest.dialogueStyles !== undefined && !Array.isArray(manifest.dialogueStyles)) continue;
      const styles: unknown[] = manifest.dialogueStyles ?? [];
      if (!styles.every(isRecord)) continue;

      const sidecar = await readJsonIfPresent<WebGalImportRecord>(
        path.join(packageRoot, WEBGAL_IMPORT_RECORD_FILE),
      );
      const styleParams = styles
        .map((style) => style.params)
        .filter(Boolean);
      const styleIds = styles
        .map((style) => String(style.id ?? ''))
        .filter(Boolean);

      records.push({
        packageId: String(manifest.template.id ?? entry.name),
        packageName: String(manifest.template.name ?? entry.name),
        // Discovery does not require the directory to be named after the package
        // id (`--out` can differ), so remember where the manifest actually lives.
        packageRoot,
        // A package id and its style id are not the same thing (`--style-id`), so
        // a replace has to keep the ids the installed styles were published under.
        styleIds,
        assetFiles: installedAssetFiles(packageRoot, manifest, styles),
        // Only a package that publishes exactly one style can be rebuilt from a
        // single WebGAL stylesheet — and only when it declares nothing else, since
        // a replace replaces the whole directory. Anything richer is a valid
        // package this import must not overwrite.
        replaceable: styleIds.length <= 1 && unimportedCapabilities(manifest).length === 0,
        hasWebGalGeneratedArtwork: hasWebGalGeneratedArtwork(styles),
        // The sidecar records the original stylesheet hash; without it a package
        // can still be matched on the parameters it translates to.
        record: {
          ...(sidecar ?? {}),
          ...(styleParams.length
            ? { paramsSignature: dialogueParamsSignature(styleParams[0]) }
            : {}),
        },
      });
    } catch {
      // A damaged package must not prevent discovery or installation of others.
      continue;
    }
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
      replaceable: entry.replaceable,
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
    unverifiableCount: installed.filter((entry) => (
      entry.hasWebGalGeneratedArtwork && !entry.record?.sourceHash
    )).length,
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
  // Guarded here as well as in the dialog: this import rebuilds the whole
  // directory from one stylesheet, so overwriting a package that publishes
  // several styles would delete the ones it cannot reproduce — along with the
  // assets only they reference. The dialog does not offer it; this refuses it.
  if (replaceTarget && !replaceTarget.replaceable) {
    throw new Error(
      `「${replaceTarget.packageName}」包含 ${replaceTarget.styleIds.length} 个对话框样式，`
      + '覆盖只会写入本次导入的一个样式，其余样式与资源会被删除。请改为新增一个模板包。',
    );
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

  // The style list de-duplicates by style id across packages, keeping the first
  // one it sees. A second package publishing an id that is already taken would
  // install successfully and then be invisible in the dropdown, so a fresh
  // import gets the same `-2` treatment the package id already gets — including
  // the default, which is the package id and can just as easily collide with a
  // style id some other package chose explicitly.
  const installedStyleIds = installed.flatMap((entry) => entry.styleIds);
  const styleId = requestedStyleId
    ? replaceTarget
      ? requestedStyleId
      : uniquePackageName(requestedStyleId, installedStyleIds)
    : replaceTarget
      ? replaceTarget.styleIds[0] ?? packageId
      : uniquePackageName(packageId, installedStyleIds);

  const { build, sourceHash, sourceName } = await convertTemplate({
    ...input,
    templateRoot,
    packageName,
    packageId,
    styleId,
    styleName: String(input.styleName ?? '').trim() || packageName,
  });

  // The manifest is only a declaration; the directory is what actually gets
  // replaced. A package may carry files this import cannot regenerate — extra
  // artwork, a hand-edited asset, anything — and replacing it would silently
  // take them with it, so refuse while the files are still there.
  if (replaceTarget) {
    const expected = new Set([
      'manifest.v2.json', WEBGAL_IMPORT_RECORD_FILE, ...replaceTarget.assetFiles,
    ]);
    const stray: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (const item of await fs.promises.readdir(
        path.join(replaceTarget.packageRoot, relative),
        { withFileTypes: true },
      )) {
        const child = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory()) await walk(child);
        else if (!expected.has(child)) stray.push(child);
      }
    };
    await walk('');
    if (stray.length > 0) {
      throw new Error(
        `「${replaceTarget.packageName}」含有本次导入无法重建的文件（${stray.slice(0, 3).join('、')}`
        + `${stray.length > 3 ? ' 等' : ''}），整包覆盖会删除它们。请改为新增一个模板包。`,
      );
    }
  }

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
        await validateTemplateFile(templateRoot, file.sourcePath);
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
