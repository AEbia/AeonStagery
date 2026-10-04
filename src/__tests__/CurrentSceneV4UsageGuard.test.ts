import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_ROOTS = ['src', 'server', 'scripts'];
const V4_DEPENDENCY = /SceneDocumentV4|SceneMetaV4|SCENE_SCHEMA_VERSION_V4|(?:get|parse|save|load|_replace|_clear)SceneDocumentV4|scene-document-v4/;
const REGISTERED_COLLABORATION_V2_SEAMS = new Set([
  'src/api/interfaces/IReadonlyDocumentStore.ts',
  'src/services/io/SceneAssetService.ts',
  'src/ui/CollaborationServerSceneAgreementDialogV2.tsx',
  'src/ui/store/DocumentStore.ts',
  'src/ui/useSemanticCollaborationSession.ts',
]);

function collectSourceFiles(relativeDirectory: string): string[] {
  const directory = path.join(REPOSITORY_ROOT, relativeDirectory);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(relativePath));
    } else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name)) {
      files.push(relativePath.replaceAll('\\', '/'));
    }
  }

  return files;
}

function isHistoricalV4Seam(relativePath: string): boolean {
  return relativePath === 'src/api/types/semantic-scene.ts'
    || relativePath === 'src/api/types/collaboration.ts'
    || relativePath === 'src/services/semantic-scene/SceneV3ToV4Migration.ts'
    || relativePath === 'scripts/migrate-scene-v2.ts'
    || relativePath.startsWith('scripts/migrations/legacy-scene/')
    || relativePath.startsWith('src/services/collaboration/')
    || relativePath.startsWith('server/collaboration/')
    || REGISTERED_COLLABORATION_V2_SEAMS.has(relativePath);
}

describe('current Scene Document v4 usage guard', () => {
  it('keeps hard-coded scene v4 dependencies out of current product paths', () => {
    const violations = SOURCE_ROOTS
      .flatMap(collectSourceFiles)
      .filter((relativePath) => !relativePath.startsWith('src/__tests__/'))
      .filter((relativePath) => !isHistoricalV4Seam(relativePath))
      .filter((relativePath) => {
        const content = fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
        return V4_DEPENDENCY.test(content);
      });

    expect(violations).toEqual([]);
  });
});
