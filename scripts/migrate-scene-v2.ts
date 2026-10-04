import { readFile, writeFile } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import type { SceneScript } from './migrations/legacy-scene/LegacySceneTypes';
import type { ProjectRelativeAssetPath } from '../src/api/types/collaboration';
import type { ResourceImportKind } from '../src/api/types/project';
import type { CurrentSceneDocument, SceneStatement } from '../src/api/types/semantic-scene';
import {
  sceneDocumentCodec,
  sceneStatementCompiler,
} from '../src/services/semantic-scene';
import { migrateLegacySceneScriptToDocumentV3 } from './migrations/legacy-scene/LegacySceneDocumentMigrator';
import { ProjectPathResolver } from '../src/services/io/ProjectPathResolver';
import { ProjectResourceService } from '../src/services/io/ProjectResourceService';
import { nodeFileAccess } from './node-file-access';
import {
  collectLive2DAssetBundleClosure,
  isLive2DAssetBundleEntrypoint,
} from '../src/services/collaboration/assets';

interface CliOptions {
  readonly inputPath: string;
  readonly outputPath?: string;
  readonly pretty: boolean;
  readonly projectRoot: string;
  readonly externalRoots: string[];
}

function printUsage(): void {
  console.log([
    'Usage: npm run migrate:scene-v2 -- <legacy-scene.json> [output.scene.v4.json] --project-root <path> [--external-root <path>] [--compact]',
    '',
    'Migrates a legacy SceneScript timeline into a SceneDocumentV4 statements file.',
    'The tool refuses to write output when fatal migration or codec validation errors remain.',
  ].join('\n'));
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  const valueFlags = new Set(['--project-root', '--external-root']);
  const positional: string[] = [];
  let projectRoot = '';
  const externalRoots: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (valueFlags.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return null;
      if (arg === '--project-root') projectRoot = value;
      else externalRoots.push(value);
      index += 1;
      continue;
    }
    if (!arg.startsWith('--')) positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) return null;
  if (!projectRoot) return null;
  return {
    inputPath: positional[0],
    outputPath: positional[1],
    pretty: !argv.includes('--compact'),
    projectRoot,
    externalRoots,
  };
}

function hasFatalIssues(issues: readonly { severity: string }[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

function reportIssues(inputPath: string, issues: readonly { severity: string; code: string; message: string; actionIndex?: number; actionId?: string; actionType?: string }[]): void {
  if (issues.length === 0) return;
  console.error(`Migration issues for ${basename(inputPath)}:`);
  for (const issue of issues) {
    const locator = [
      issue.actionIndex !== undefined ? `index=${issue.actionIndex}` : undefined,
      issue.actionId ? `id=${issue.actionId}` : undefined,
      issue.actionType ? `action=${issue.actionType}` : undefined,
    ].filter(Boolean).join(' ');
    console.error(`- ${issue.severity.toUpperCase()} ${issue.code}${locator ? ` (${locator})` : ''}: ${issue.message}`);
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    printUsage();
    return process.argv.some((arg) => arg === '--help' || arg === '-h') ? 0 : 1;
  }

  const raw = await readFile(options.inputPath, 'utf8');
  const legacyScene = JSON.parse(raw) as SceneScript;
  const result = migrateLegacySceneScriptToDocumentV3(legacyScene, { validate: false });
  reportIssues(options.inputPath, result.issues);

  if (!result.document || hasFatalIssues(result.issues)) {
    console.error('Legacy scene migration to v3 failed; no output was written.');
    return 1;
  }

  const resources = new ProjectResourceService(
    nodeFileAccess,
    new ProjectPathResolver(),
    () => options.externalRoots.map((path, index) => ({ id: `migration-root-${index + 1}`, path })),
  );
  resources.setCurrentProject(await resources.loadProject(options.projectRoot));
  const projectized = await projectizeSceneDocument(result.document, resources);
  sceneStatementCompiler.compile(projectized);

  const outputJson = JSON.stringify(projectized, null, options.pretty ? 2 : 0);
  if (options.outputPath) {
    await writeFile(options.outputPath, `${outputJson}\n`, 'utf8');
    console.log(`Wrote ${options.outputPath}`);
  } else {
    console.log(outputJson);
  }
  return 0;
}

async function projectizeSceneDocument(
  document: CurrentSceneDocument,
  resources: ProjectResourceService,
): Promise<CurrentSceneDocument> {
  const next = JSON.parse(JSON.stringify(document)) as CurrentSceneDocument;
  for (const character of next.meta.characters ?? []) {
    if (character.model) character.model = await projectize(character.model, 'figure', resources);
    for (const variant of character.variants ?? []) {
      variant.model = await projectize(variant.model, 'figure', resources);
    }
  }
  for (const statement of next.statements) {
    await projectizeStatement(statement, resources);
    for (const companion of statement.companions ?? []) {
      await projectizeStatement(companion as SceneStatement, resources);
    }
  }
  return sceneDocumentCodec.parseAndValidate(next);
}

async function projectizeStatement(
  statement: Pick<SceneStatement, 'type' | 'params'>,
  resources: ProjectResourceService,
): Promise<void> {
  const params = statement.params as Record<string, unknown>;
  const fields: Array<[string, ResourceImportKind]> = [];
  if (statement.type === 'dialogue') fields.push(['voice', 'vocal']);
  if (statement.type === 'characterPresence') fields.push(['model', 'figure']);
  if (statement.type === 'environmentLayer') fields.push(['file', 'background'], ['image', 'background']);
  if (statement.type === 'audio') fields.push(['file', 'bgm']);
  if (statement.type === 'graphicLayer') fields.push(['file', 'images']);
  if (statement.type === 'customAnimation') fields.push(['file', 'animation'], ['animation', 'animation']);
  for (const [field, kind] of fields) {
    const value = params[field];
    if (typeof value === 'string' && value.trim()) {
      params[field] = await projectize(value, kind, resources);
    }
  }
}

async function projectize(
  source: string,
  kind: ResourceImportKind,
  resources: ProjectResourceService,
): Promise<string> {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source) || /^data:/i.test(source)) {
    throw new Error(`URL-style asset reference cannot be migrated: "${source}"`);
  }
  const resolver = new ProjectPathResolver();
  const isAbsolute = resolver.isAbsolutePath(source);
  const isOutsideProject = isAbsolute
    ? await resources.classifySource(source) === 'outsideProject'
    : false;
  const imported = isAbsolute
    ? await resources.importIntoProject(source, kind, 'copy')
    : await resources.normalizeForStorage(source, kind);
  if (kind === 'figure' && isOutsideProject && isLive2DAssetBundleEntrypoint(source)) {
    await copyLive2DBundleDependencies(source, imported.relativePath, resources);
  }
  return imported.relativePath;
}

async function copyLive2DBundleDependencies(
  sourceEntrypoint: string,
  projectEntrypoint: string,
  resources: ProjectResourceService,
): Promise<void> {
  const entries = await collectLive2DAssetBundleClosure({
    sourcePath: sourceEntrypoint.replace(/\\/g, '/'),
    projectRelativePath: projectEntrypoint as ProjectRelativeAssetPath,
  }, {
    readText: async (sourcePath) => (await nodeFileAccess.readFile(sourcePath)).data,
    dirname: (sourcePath) => nodeFileAccess.dirname(sourcePath),
    joinSource: async (baseDir, childPath) => (await nodeFileAccess.join(baseDir, childPath)).replace(/\\/g, '/'),
    joinProjectRelative: (baseDir, childPath) =>
      posix.normalize(posix.join(baseDir, childPath)) as ProjectRelativeAssetPath,
    normalizeSourcePath: (sourcePath) => sourcePath.replace(/\\/g, '/').toLowerCase(),
    validateReference: (reference) => {
      const resolver = new ProjectPathResolver();
      if (resolver.isAbsolutePath(reference) || resolver.isUrlLike(reference)) {
        throw new Error(`Live2D bundle reference must be relative: "${reference}"`);
      }
    },
  });
  for (const entry of entries.slice(1)) {
    const target = await resources.resolveForProjectWrite(entry.projectRelativePath);
    await nodeFileAccess.ensureDir(await nodeFileAccess.dirname(target));
    await nodeFileAccess.copyFile(entry.sourcePath, target);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
