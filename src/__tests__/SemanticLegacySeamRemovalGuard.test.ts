import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const AI_SCRIPT_SEGMENT_COMPILER_PATH = path.join(ROOT, 'services', 'ai-authoring', 'AiScriptSegmentCompiler.ts');

const removedLegacyPaths = [
  'api/adapters/DocumentAdapter.ts',
  'api/interfaces/IDocumentAdapter.ts',
  'api/interfaces/IUiDocumentAdapter.ts',
  'api/interfaces/ITimelineAuthoringService.ts',
  'api/interfaces/IVisualCompositionAuthoringService.ts',
  'api/types/legacy-scene.ts',
  'services/character-directory/CharacterDirectoryService.ts',
  'services/timeline-authoring/TimelineAuthoringService.ts',
  'services/timeline-authoring/TimelineAuthoringResolver.ts',
  'services/timeline-authoring/DocumentStructuralAuthoringCommitter.ts',
  'services/timeline-authoring/StructuralAuthoringCommitter.ts',
  'services/timeline-authoring/operations/types.ts',
  'services/timeline-authoring/policies/ResourceAuthoringPolicy.ts',
  'services/timeline-authoring/policies/ScopeApplicationRegistry.ts',
  'services/timeline-authoring/registries/ActionDefaultsRegistry.ts',
  'services/timeline-authoring/registries/TemplateRegistry.ts',
  'services/timeline-authoring/resolver/stages.ts',
  'services/timeline-authoring/resolver/types.ts',
  'services/visual-authoring/VisualCompositionAuthoringService.ts',
  'services/visual-authoring/VisualAuthoringService.ts',
  'services/document/DocumentProjectionCoordinator.ts',
  'services/document/DocumentPreviewProjectionRules.ts',
  'engine/DocumentProjectionRuntimeAdapter.ts',
  'engine/SceneCompiler.ts',
  'engine/SceneValidator.ts',
  'ui/timeline/rawScriptPatch.ts',
  'ui/timeline/authoring.ts',
];

const DOCUMENT_STORE_PATH = path.join(ROOT, 'ui', 'store', 'DocumentStore.ts');
const TEMPLATE_MANIFEST_PATH = path.join(ROOT, 'services', 'template-package', 'TemplatePackageManifest.ts');
const VALIDATION_TYPE_CONSUMERS = [
  path.join(ROOT, 'api', 'interfaces', 'IProjectOpenWorkflow.ts'),
  path.join(ROOT, 'services', 'io', 'SceneFileService.ts'),
  path.join(ROOT, 'services', 'project', 'ProjectOpenWorkflow.ts'),
  path.join(ROOT, 'services', 'semantic-scene', 'SemanticSceneValidator.ts'),
  path.join(ROOT, 'ui', 'store', 'ValidationStore.ts'),
];
const removedDocumentStoreMutators = [
  '_setScene',
  '_applyPatch',
  '_applyPatches',
  '_addAction',
  '_deleteAction',
  '_insertActions',
  '_setMetaField',
  '_setTimeline',
  '_rebuildSceneData',
];

describe('semantic legacy seam removal guard', () => {
  it('does not keep deleted action-centric authoring/document modules', () => {
    for (const relativePath of removedLegacyPaths) {
      expect(fs.existsSync(path.join(ROOT, relativePath)), relativePath).toBe(false);
    }
  });

  it('does not re-export deleted legacy Interfaces', () => {
    const exports = fs.readFileSync(path.join(ROOT, 'api/interfaces/index.ts'), 'utf8');
    expect(exports).not.toContain('IDocumentAdapter');
    expect(exports).not.toContain('IUiDocumentAdapter');
    expect(exports).not.toContain('ITimelineAuthoringService');
    expect(exports).not.toContain('IVisualCompositionAuthoringService');
    expect(exports).not.toContain('ICharacterDirectoryService');
  });

  it('does not retain id-based DocumentStore mutation seams', () => {
    const content = fs.readFileSync(DOCUMENT_STORE_PATH, 'utf8');
    for (const mutator of removedDocumentStoreMutators) {
      expect(content, mutator).not.toContain(mutator);
    }
  });

  it('keeps template manifest parsing off the source-level legacy scene union', () => {
    const content = fs.readFileSync(TEMPLATE_MANIFEST_PATH, 'utf8');
    expect(content).toContain('LegacyTemplateActionName');
    expect(content).not.toContain('legacy-scene');
    expect(content).not.toContain('LegacyActionType');
  });

  it('keeps AI script segment compiler on semantic statement output only', () => {
    const content = fs.readFileSync(AI_SCRIPT_SEGMENT_COMPILER_PATH, 'utf8');
    expect(content).toContain('compileAiScriptSegmentPlanToSceneStatements');
    expect(content).not.toMatch(/export function compileAiScriptSegmentPlan\s*\(/);
    expect(content).not.toContain('legacy-scene');
    expect(content).not.toContain('SceneScript');
    expect(content).not.toContain('LegacyActionType');
  });

  it('keeps product validation issue types off the legacy validator module', () => {
    for (const fullPath of VALIDATION_TYPE_CONSUMERS) {
      const content = fs.readFileSync(fullPath, 'utf8');
      expect(content, fullPath).toContain('types/validation');
      expect(content, fullPath).not.toContain('engine/SceneValidator');
    }
  });
});
