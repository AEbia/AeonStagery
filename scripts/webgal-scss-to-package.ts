/**
 * Convert a WebGAL dialogue template into an AeonStagery template package.
 *
 *   npm run import:webgal-template -- "<webgal template dir>" [options]
 *
 * The WebGAL template keeps its subtitle styling in `Stage/TextBox/textbox.scss`
 * plus a few SVGs under `assets/`. This command reads those, and writes a
 * package the editor can load directly:
 *
 *   <out>/manifest.v2.json
 *   <out>/assets/ui/dialogue/webgal/textbox-<hash>.svg
 *   <out>/assets/ui/dialogue/webgal/namebox-<hash>.svg
 *   <out>/assets/fonts/<font>                     (only when the template ships one)
 *
 * Drop the output directory into a project's `templates/` folder (or the
 * editor's template library) and the style shows up in the dialogue style list.
 *
 * The conversion itself lives in `src/services/import/webgal/` and is pure, so
 * the in-app importer can reuse it without shelling out.
 */
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseBlocks, urlBasename } from '../src/services/import/webgal/WebGalScssSyntax';
import { extractWebGalTextBoxTheme } from '../src/services/import/webgal/WebGalTextboxScssTranslator';
import {
  buildWebGalTextboxTemplatePackage,
  describeWebGalTemplatePackageFiles,
  type WebGalScssDecorationSources,
  type WebGalTemplatePackageBuild,
  type WebGalTemplatePackageFont,
} from '../src/services/import/webgal/WebGalTextboxScssPackage';

const USAGE = `Usage: npm run import:webgal-template -- "<webgal template dir>" [options]

Options:
  --out <dir>            Package directory (default: ./<package id>)
  --id <package id>      Template package id (default: webgal-scss.<template name>)
  --name <name>          Display name (default: name from template.json)
  --style-id <id>        Dialogue style id (default: the package id)
  --style-name <name>    Dialogue style label (default: the display name)
  --version <version>    Package version (default: 1.0.0)
  --author <author>      Package author
  --description <text>   Package description
  --no-font              Do not copy the font declared in template.json
  --strict-center        Centre the text column instead of honouring left/right
  --force                Write into a non-empty output directory
`;

interface WebGalTemplateJson {
  name?: unknown;
  fonts?: unknown;
}

interface CliOptions {
  templateRoot: string;
  out?: string;
  id?: string;
  name?: string;
  styleId?: string;
  styleName?: string;
  version?: string;
  author?: string;
  description?: string;
  withFont: boolean;
  strictCenter: boolean;
  force: boolean;
}

const VALUE_FLAGS = new Set([
  '--out', '--id', '--name', '--style-id', '--style-name', '--version', '--author', '--description',
]);

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option ${arg} expects a value`);
      }
      values[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    flags.add(arg);
  }

  if (positional.length !== 1) throw new Error(USAGE);

  return {
    templateRoot: positional[0],
    out: values.out,
    id: values.id,
    name: values.name,
    styleId: values['style-id'],
    styleName: values['style-name'],
    version: values.version,
    author: values.author,
    description: values.description,
    withFont: !flags.has('--no-font'),
    strictCenter: flags.has('--strict-center'),
    force: flags.has('--force'),
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfPresent(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/** Turn any template name into a usable package directory name. */
function slugify(name: string): string {
  const cleaned = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 48);
  return cleaned || 'webgal-template';
}

/** Locate `Stage/TextBox/textbox.scss`, accepting either a template root or the file itself. */
async function resolveTemplateRoot(input: string): Promise<string> {
  const resolved = path.resolve(input);
  if (path.basename(resolved).toLowerCase() === 'textbox.scss') {
    const root = path.dirname(path.dirname(path.dirname(resolved)));
    if (!(await exists(path.join(root, 'Stage', 'TextBox', 'textbox.scss')))) {
      throw new Error(`Cannot locate Stage/TextBox/textbox.scss above ${input}`);
    }
    return root;
  }
  if (!(await exists(path.join(resolved, 'Stage', 'TextBox', 'textbox.scss')))) {
    throw new Error(
      `No Stage/TextBox/textbox.scss inside "${input}".\n` +
      'Point this command at a WebGAL template directory (the one holding template.json).',
    );
  }
  return resolved;
}

async function readTemplateName(root: string, fallback: string): Promise<string> {
  const raw = await readTextIfPresent(path.join(root, 'template.json'));
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as WebGalTemplateJson;
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    return name || fallback;
  } catch {
    console.warn('  ! template.json 解析失败，已使用目录名作为模板名称');
    return fallback;
  }
}

/** Font declared by `template.json`, if it ships one that exists on disk. */
async function resolveFont(root: string, enabled: boolean): Promise<WebGalTemplatePackageFont | null> {
  if (!enabled) return null;
  const raw = await readTextIfPresent(path.join(root, 'template.json'));
  if (!raw) return null;

  let fonts: unknown;
  try {
    fonts = (JSON.parse(raw) as WebGalTemplateJson).fonts;
  } catch {
    return null;
  }
  if (!Array.isArray(fonts)) return null;

  for (const entry of fonts) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const family = typeof record['font-family'] === 'string' ? record['font-family'].trim() : '';
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!family || !url) continue;
    // WebGAL also ships a pre-compressed `.gz` copy for its own transfer path;
    // the editor loads the font directly, so skip it.
    if (/\.gz$/i.test(url)) continue;
    // `template.json` is data, not a path: a `url` of `../../…`, an absolute
    // path or a symlink pointing outside would copy an unrelated local file
    // into the exported package. Resolve it, then confirm the *real* path is
    // still inside the template directory.
    const sourcePath = path.resolve(root, url);
    if (await exists(sourcePath)) {
      const [insideTemplate, realTemplateRoot, realSourcePath] = await Promise.all([
        isInside(root, sourcePath),
        realpath(root),
        realpath(sourcePath),
      ]);
      if (!insideTemplate || !isInside(realTemplateRoot, realSourcePath)) {
        throw new Error(
          `模板字体指向模板目录之外的文件：${url}\n`
          + '出于安全性考虑，已拒绝导入模板目录外的文件。',
        );
      }
      return { family, sourcePath };
    }
  }
  return null;
}

/** Whether `candidate` resolves to something inside `root`, path-segment wise. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Read the `::after` ornaments the theme references, so they can be inlined. */
async function readDecorationSources(
  root: string,
  scss: string,
): Promise<WebGalScssDecorationSources> {
  const theme = extractWebGalTextBoxTheme(parseBlocks(scss));
  const out: WebGalScssDecorationSources = {};

  for (const slot of ['textbox', 'namebox'] as const) {
    const decoration = theme[slot].deco;
    if (!decoration?.file) continue;
    // The translator already reduced `url(...)` to a file name; the extra pass
    // keeps this working if that ever changes to storing the raw declaration.
    const fileName = urlBasename(decoration.file) ?? decoration.file;
    const candidate = path.join(root, 'assets', fileName);
    const contents = await readTextIfPresent(candidate);
    if (contents == null) {
      console.warn(`  ! 未找到 .${slot} 引用的装饰素材 "${fileName}"，已跳过`);
      continue;
    }
    out[slot] = contents;
  }
  return out;
}

async function assertWritableTarget(outDir: string, force: boolean): Promise<void> {
  if (!(await exists(outDir))) return;
  const current = await stat(outDir);
  if (!current.isDirectory()) throw new Error(`输出路径已存在且不是目录：${outDir}`);
  if (force) return;
  // `--force` is documented as "write into a non-empty directory", so the
  // default has to mean the opposite: refuse anything that is not empty.
  // Checking only for `manifest.v2.json` let a directory holding unrelated files
  // through, and the writer would then overwrite whatever it collided with.
  const entries = await readdir(outDir);
  if (entries.length > 0) {
    throw new Error(
      `输出目录不为空（${entries.slice(0, 3).join('、')}${entries.length > 3 ? ' 等' : ''}）：${outDir}\n`
      + '若需覆盖已有文件，请传入 --force 参数，或指定其他 --out 目录。',
    );
  }
}

async function writePackage(outDir: string, build: WebGalTemplatePackageBuild): Promise<void> {
  for (const file of build.files) {
    const target = path.join(outDir, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    if (file.sourcePath) {
      await copyFile(file.sourcePath, target);
      continue;
    }
    await writeFile(target, file.contents ?? '', 'utf8');
  }
}

function report(build: WebGalTemplatePackageBuild, outDir: string): void {
  console.log('\nPackage contents');
  for (const entry of describeWebGalTemplatePackageFiles(build)) console.log(`  ${entry}`);
  console.log(`  -> ${outDir}`);

  if (build.notes.length) {
    console.log('\nImport notes');
    for (const note of build.notes) console.log(`  - ${note}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const templateRoot = await resolveTemplateRoot(options.templateRoot);
  console.log(`WebGAL template: ${templateRoot}`);

  const templateName = options.name?.trim()
    || await readTemplateName(templateRoot, path.basename(templateRoot));
  const templateId = options.id?.trim() || `webgal-scss.${slugify(templateName)}`;
  const styleId = options.styleId?.trim() || templateId;
  const styleName = options.styleName?.trim() || templateName;

  const scss = await readFile(path.join(templateRoot, 'Stage', 'TextBox', 'textbox.scss'), 'utf8');
  const font = await resolveFont(templateRoot, options.withFont);
  const decoSources = await readDecorationSources(templateRoot, scss);

  if (font) console.log(`Font: ${font.family} (${path.basename(font.sourcePath)})`);

  const build = buildWebGalTextboxTemplatePackage({
    scss,
    templateId,
    templateName,
    sourceName: 'textbox.scss',
    styleId,
    styleName,
    version: options.version,
    author: options.author,
    description: options.description,
    font,
    decoSources,
    strictCenter: options.strictCenter,
  });

  const outDir = path.resolve(options.out ?? templateId);
  await assertWritableTarget(outDir, options.force);
  await writePackage(outDir, build);

  console.log(`\nWrote package "${templateId}" (dialogue style "${styleId}" / "${styleName}")`);
  report(build, outDir);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
