import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_ASSET_ROOTS } from '../api/types/project';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('semantic migration CLI', () => {
  it('projectizes external assets and validates the migrated scene', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aeon-scene-v2-'));
    tempRoots.push(root);
    const projectRoot = path.join(root, 'project');
    const externalRoot = path.join(root, 'external');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(externalRoot, { recursive: true });
    const externalAudio = path.join(externalRoot, 'impact.ogg');
    await writeFile(externalAudio, 'audio-fixture');

    const now = new Date().toISOString();
    await writeFile(path.join(projectRoot, 'project.json'), JSON.stringify({
      projectId: 'migration-test',
      name: 'Migration test',
      projectVersion: 1,
      createdAt: now,
      updatedAt: now,
      defaultSceneId: 'main',
      scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
      assetRoots: DEFAULT_PROJECT_ASSET_ROOTS,
    }, null, 2));

    const inputPath = path.join(root, 'legacy.json');
    const outputPath = path.join(projectRoot, 'project', 'main.scene.json');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(inputPath, JSON.stringify({
      sceneId: 'main',
      meta: { title: 'Migrated' },
      timeline: [{
        action: 'playAudio',
        time: 0,
        params: { id: 'impact', file: externalAudio, duration: 1 },
      }],
    }));

    const result = spawnSync(process.execPath, [
      path.resolve('node_modules/tsx/dist/cli.mjs'),
      path.resolve('scripts/migrate-scene-v2.ts'),
      inputPath,
      outputPath,
      '--project-root',
      projectRoot,
      '--external-root',
      externalRoot,
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const output = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(output.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(output.statements[0].params.file).toBe('impact.ogg');
    expect(await readFile(path.join(projectRoot, 'impact.ogg'), 'utf8')).toBe('audio-fixture');
  });
});
