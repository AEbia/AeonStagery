import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROJECT_ASSET_ROOTS,
  DEFAULT_PROJECT_TEMPLATE_CONFIGURATION,
  DEFAULT_PROJECT_VOICE_GENERATION_CONFIGURATION,
  type ProjectMetadata,
} from '../../../src/api/types/project';
import {
  SCENE_SCHEMA_VERSION_V5,
  type SceneDocumentV5,
} from '../../../src/api/types/semantic-scene';

export interface FixtureProject {
  rootPath: string;
  projectFilePath: string;
  sceneFilePath: string;
}

export interface FixtureProjectOptions {
  name?: string;
  scene?: SceneDocumentV5;
}

export interface FixtureProjectFiles {
  project: ProjectMetadata;
  scene: SceneDocumentV5;
}

export const FIXTURE_CHARACTER_ID = 'e2e_hero';
export const FIXTURE_DIALOGUE_ACTION_ID = 'e2e-dialogue-existing';

export async function createFixtureProject(options: FixtureProjectOptions = {}): Promise<FixtureProject> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'aeon-e2e-project-'));
  const projectDir = path.join(rootPath, DEFAULT_PROJECT_ASSET_ROOTS.project);
  const sceneFilePath = path.join(projectDir, 'main.scene.json');
  const projectFilePath = path.join(rootPath, 'project.json');
  const projectName = options.name ?? 'E2E Editing Smoke';

  await Promise.all(
    Object.values(DEFAULT_PROJECT_ASSET_ROOTS).map((assetRoot) =>
      fs.mkdir(path.join(rootPath, assetRoot), { recursive: true }),
    ),
  );

  const now = new Date().toISOString();
  const metadata: ProjectMetadata = {
    projectId: 'e2e-editing-smoke',
    name: projectName,
    projectVersion: 2,
    createdAt: now,
    updatedAt: now,
    defaultSceneId: 'main',
    scenes: [{ id: 'main', name: 'Main Scene', path: 'project/main.scene.json' }],
    assetRoots: { ...DEFAULT_PROJECT_ASSET_ROOTS },
    templates: { ...DEFAULT_PROJECT_TEMPLATE_CONFIGURATION },
    voiceGeneration: { ...DEFAULT_PROJECT_VOICE_GENERATION_CONFIGURATION },
  };

  const scene: SceneDocumentV5 = {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'main',
    meta: {
      title: projectName,
      resolution: [1920, 1080],
      fps: 60,
      durationSeconds: 15,
      characters: [],
    },
    statements: [],
  };

  await fs.writeFile(projectFilePath, JSON.stringify(metadata, null, 2), 'utf8');
  await fs.writeFile(sceneFilePath, JSON.stringify(options.scene ?? scene, null, 2), 'utf8');

  return { rootPath, projectFilePath, sceneFilePath };
}

export async function createEmptyFixtureProject(
  options: Omit<FixtureProjectOptions, 'scene'> = {},
): Promise<FixtureProject> {
  return createFixtureProject(options);
}

export async function createSavedFixtureProject(
  options: FixtureProjectOptions = {},
): Promise<FixtureProject> {
  const projectName = options.name ?? 'E2E Reopen Persistence';
  return createFixtureProject({
    ...options,
    name: projectName,
    scene: options.scene ?? createSavedDialogueScene(projectName),
  });
}

export async function cleanupFixtureProject(fixture: FixtureProject): Promise<void> {
  await fs.rm(fixture.rootPath, { recursive: true, force: true }).catch(() => undefined);
}

export async function readSceneDocument(sceneFilePath: string): Promise<SceneDocumentV5> {
  return JSON.parse(await fs.readFile(sceneFilePath, 'utf8')) as SceneDocumentV5;
}

export async function readProjectMetadata(projectFilePath: string): Promise<ProjectMetadata> {
  return JSON.parse(await fs.readFile(projectFilePath, 'utf8')) as ProjectMetadata;
}

export async function readFixtureProjectFiles(fixture: FixtureProject): Promise<FixtureProjectFiles> {
  const [project, scene] = await Promise.all([
    readProjectMetadata(fixture.projectFilePath),
    readSceneDocument(fixture.sceneFilePath),
  ]);
  return { project, scene };
}

function createSavedDialogueScene(projectName: string): SceneDocumentV5 {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION_V5,
    sceneId: 'main',
    meta: {
      title: projectName,
      resolution: [1920, 1080],
      fps: 60,
      durationSeconds: 15,
      characters: [{ id: FIXTURE_CHARACTER_ID, name: 'E2E 主角' }],
    },
    statements: [{
      id: FIXTURE_DIALOGUE_ACTION_ID,
      time: 1,
      type: 'dialogue',
      params: {
        speakerId: FIXTURE_CHARACTER_ID,
        text: 'E2E dialogue before restart',
        durationSeconds: 2,
      },
    }],
  };
}
