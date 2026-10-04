import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_ENGINE_PATH = path.join(ROOT, 'engine', 'ScriptEngine.ts');
const PRE_BAKE_DAEMON_PATH = path.join(ROOT, 'engine', 'daemons', 'PreBakeDaemon.ts');
const BAKE_ENGINE_PATH = path.join(ROOT, 'engine', 'BakeEngine.ts');
const PREPARED_RUNTIME_SCENE_PATH = path.join(ROOT, 'engine', 'PreparedRuntimeScene.ts');
const RUNTIME_TIMELINE_SCENE_PATH = path.join(ROOT, 'engine', 'RuntimeTimelineScene.ts');
const SCENE_ASSET_SERVICE_PATH = path.join(ROOT, 'services', 'io', 'SceneAssetService.ts');
const SEMANTIC_SERVICE_ROOT = path.join(ROOT, 'services', 'semantic-scene');
const SEMANTIC_BOUNDARY_FILES = [
  ...fs.readdirSync(path.join(ROOT, 'services', 'collaboration'))
    .filter((name) => name.endsWith('V2.ts'))
    .map((name) => path.join(ROOT, 'services', 'collaboration', name)),
  ...fs.readdirSync(path.join(ROOT, 'services', 'timeline-authoring'))
    .filter((name) => name.startsWith('Semantic') && name.endsWith('.ts'))
    .map((name) => path.join(ROOT, 'services', 'timeline-authoring', name)),
  ...fs.readdirSync(path.join(ROOT, 'services', 'visual-authoring'))
    .filter((name) => name.startsWith('Semantic') && name.endsWith('.ts'))
    .map((name) => path.join(ROOT, 'services', 'visual-authoring', name)),
  path.join(ROOT, 'services', 'document', 'SemanticDocumentCoordinator.ts'),
];
const SEMANTIC_SOURCE_FILES = [
  ...fs.readdirSync(SEMANTIC_SERVICE_ROOT)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(SEMANTIC_SERVICE_ROOT, name)),
  path.join(ROOT, 'services', 'timeline-authoring', 'SemanticAuthoringApplicationService.ts'),
  path.join(ROOT, 'services', 'timeline-authoring', 'SemanticAuthoringReceipt.ts'),
  path.join(ROOT, 'services', 'timeline-authoring', 'SemanticTimelineAuthoringService.ts'),
  path.join(ROOT, 'api', 'types', 'authoring.ts'),
  path.join(ROOT, 'api', 'types', 'semantic-scene.ts'),
  path.join(ROOT, 'api', 'types', 'visual-authoring.ts'),
  path.join(ROOT, 'api', 'types', 'collaboration.ts'),
  path.join(ROOT, 'api', 'types', 'ai-authoring.ts'),
];
const LIVE2D_MANAGER_PATH = path.join(ROOT, 'engine', 'Live2DManager.ts');
const LIVE2D_MOTION_CONTROLLER_PATH = path.join(ROOT, 'engine', 'Live2DMotionController.ts');
const BAKE_MOTION_RUNTIME_PATH = path.join(ROOT, 'engine', 'BakeMotionRuntime.ts');

/**
 * Jannchie pixi-live2d-display private fields and SDK globals the engine must
 * never touch directly — every access goes through Live2DRuntimeAdapter
 * controls or the adapter-owned clock handle. The lock family names
 * (acquireUtSystemLock / releaseUtSystemLock / isUtSystemLockActive) are
 * intentionally engine-owned infrastructure, so the SDK-clock global is
 * matched word-bounded to let them pass.
 */
const JANNCHIE_INTERNALS = [
  'internalModel',
  'coreModel',
  'motionManager',
  'expressionManager',
  '_motionQueueManager',
  'focusController',
  'eyeBlink',
  'renderer.render(',
  'model.update(',
  'model.destroy({',
  'WebGLBuffer',
];

describe('runtime source seam guard', () => {
  it('keeps tracked scene data and builtin templates on scene schema v3', () => {
    const repositoryRoot = path.resolve(ROOT, '..');
    const trackedJson = execFileSync('git', ['ls-files', '--', '*.json'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim().split(/\r?\n/).filter(Boolean).map((file) => file.replaceAll('\\', '/'));
    const trackedSceneOrProjectData = trackedJson.filter((file) =>
      file.endsWith('.scene.json') || /(^|\/)dev-projects?\//.test(file),
    );
    const builtinTemplateManifests = trackedJson.filter((file) =>
      file.startsWith('src/templates/default/manifest'),
    );

    expect(trackedSceneOrProjectData).toEqual([]);
    expect(builtinTemplateManifests).toEqual(['src/templates/default/manifest.v2.json']);
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, builtinTemplateManifests[0]), 'utf8'));
    expect(manifest.manifestSchemaVersion).toBe(2);
    expect(manifest.template.compatibility.sceneSchemaVersion).toBe(4);
  });

  it('keeps ScriptEngine on the prepared semantic runtime entry', () => {
    const content = fs.readFileSync(SCRIPT_ENGINE_PATH, 'utf8');

    expect(content, 'ScriptEngine should not read scene files directly').not.toContain('readTextFile');
    expect(content, 'ScriptEngine should not parse raw scene JSON directly').not.toContain('JSON.parse');
    expect(content, 'ScriptEngine should expose the prepared semantic runtime entry')
      .toContain('loadPreparedScene(scene: PreparedCompiledScene)');
    expect(content, 'ScriptEngine should use the runtime timeline adapter')
      .toContain('preparedSceneToRuntimeTimelineScene(scene)');
    expect(content, 'ScriptEngine should not expose the legacy SceneScript entry')
      .not.toMatch(/async\s+loadScene\s*\(/);
    expect(content, 'ScriptEngine should not use the legacy-named prepared adapter')
      .not.toContain('preparedSceneToRuntimeScript');
  });

  it('keeps runtime bake on the prepared runtime timeline adapter', () => {
    const content = fs.readFileSync(BAKE_ENGINE_PATH, 'utf8');

    expect(content).toContain('preparedSceneToRuntimeTimelineScene(scene)');
    expect(content).toContain("from './RuntimeSceneState'");
    expect(content).not.toContain("from './SceneCompiler'");
    expect(content).not.toContain('preparedSceneToRuntimeScript');
    expect(content).not.toMatch(/\basync\s+bakeRange\s*\(/);
  });

  it('keeps scheduler projection and timeline shapes engine-private', () => {
    expect(fs.existsSync(path.join(ROOT, 'api', 'types', 'runtime-scene.ts'))).toBe(false);
    expect(fs.existsSync(PREPARED_RUNTIME_SCENE_PATH)).toBe(true);
    expect(fs.existsSync(RUNTIME_TIMELINE_SCENE_PATH)).toBe(true);

    const runtimeTypes = fs.readFileSync(RUNTIME_TIMELINE_SCENE_PATH, 'utf8');
    expect(runtimeTypes).not.toContain('RuntimeActionType | string');
    const adapter = fs.readFileSync(PREPARED_RUNTIME_SCENE_PATH, 'utf8');
    expect(adapter).toContain('preparedSceneToRuntimeTimelineScene');
  });

  it('does not expose migration-only scene code through semantic services', () => {
    const exports = fs.readFileSync(path.join(SEMANTIC_SERVICE_ROOT, 'index.ts'), 'utf8');
    expect(exports).not.toContain('LegacySceneDocumentMigrator');
    expect(fs.existsSync(path.join(SEMANTIC_SERVICE_ROOT, 'LegacySceneTypes.ts'))).toBe(false);
    expect(fs.existsSync(path.join(SEMANTIC_SERVICE_ROOT, 'LegacySceneDocumentMigrator.ts'))).toBe(false);
  });

  it('keeps ScriptEngine state reconstruction off the legacy compiler module', () => {
    const content = fs.readFileSync(SCRIPT_ENGINE_PATH, 'utf8');

    expect(content).toContain("from './RuntimeSceneState'");
    expect(content).not.toContain("from './SceneCompiler'");
  });

  it('keeps PreBakeDaemon on prepared semantic bake inputs', () => {
    const content = fs.readFileSync(PRE_BAKE_DAEMON_PATH, 'utf8');

    expect(content).toContain('PreparedCompiledScene');
    expect(content).toContain('bakePreparedRange(');
    expect(content).not.toContain('resolvePath: (p: string) => string');
    expect(content).not.toContain('legacy-scene');
    expect(content).not.toContain('SceneScript');
    expect(content).not.toContain('bakeRange(');
  });

  it('keeps scene asset service on a local asset-reference scene shape', () => {
    const content = fs.readFileSync(SCENE_ASSET_SERVICE_PATH, 'utf8');

    expect(content).toContain('AssetReferenceScene');
    expect(content).not.toContain('legacy-scene');
    expect(content).not.toContain('SceneScript');
  });

  it('keeps semantic runtime modules independent from reverse compilation', () => {
    const files = fs.readdirSync(SEMANTIC_SERVICE_ROOT)
      .filter((name) => name.endsWith('.ts') && !name.startsWith('LegacySceneDocumentMigrator'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(SEMANTIC_SERVICE_ROOT, file), 'utf8');
      expect(content, file).not.toContain('SceneCompiler.decompile');
    }
  });

  it('keeps semantic state and collaboration modules behind v2 contracts', () => {
    for (const file of SEMANTIC_BOUNDARY_FILES) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content, file).not.toContain('SceneCompiler.decompile');
      expect(content.replaceAll('VISUAL_AUTHORING_SCHEMA_VERSION_V2', ''), file)
        .not.toContain('AUTHORING_SCHEMA_VERSION_V2');
      expect(content, file).not.toMatch(/\bCOLLABORATION_SCHEMA_VERSION\b(?!_V2)/);
      expect(content, file).not.toMatch(/\bActionType\b/);
    }
  });

  it('keeps legacy SceneScript imports behind the named compatibility module', () => {
    for (const file of SEMANTIC_SOURCE_FILES) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content, file).not.toContain("types/scene'");
      expect(content, file).not.toContain('from \'./scene\'');
    }
  });

  it('keeps Jannchie runtime internals inside the Live2D runtime adapter (model rendering consumers)', () => {
    const clockGlobal = /(?<![A-Za-z])UtSystem(?![A-Za-z])/;
    const files = [
      BAKE_ENGINE_PATH,
      LIVE2D_MANAGER_PATH,
    ];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const fragment of JANNCHIE_INTERNALS) {
        expect(content, `${file} must not reach into Jannchie internals (${fragment})`)
          .not.toContain(fragment);
      }
      expect(content, `${file} must not touch the SDK clock global directly`)
        .not.toMatch(clockGlobal);
    }
  });

  it('keeps Jannchie runtime internals inside the Live2D runtime adapter (motion controller)', () => {
    // The motion controller iterates the adapter-seam focus handles as local
    // variables in its tween teardown, so `focusController` is exempt here.
    const banned = JANNCHIE_INTERNALS.filter((fragment) => fragment !== 'focusController');
    const clockGlobal = /(?<![A-Za-z])UtSystem(?![A-Za-z])/;
    const files = [
      LIVE2D_MOTION_CONTROLLER_PATH,
      BAKE_MOTION_RUNTIME_PATH,
    ];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const fragment of banned) {
        expect(content, `${file} must not reach into Jannchie internals (${fragment})`)
          .not.toContain(fragment);
      }
      expect(content, `${file} must not touch the SDK clock global directly`)
        .not.toMatch(clockGlobal);
    }
  });
});
