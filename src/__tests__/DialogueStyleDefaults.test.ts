import { describe, expect, it, vi } from 'vitest';
import { AUTHORING_SCHEMA_VERSION, type SemanticAuthorIntent } from '../api/types/authoring';
import type { ProjectTemplateConfiguration } from '../api/types/project';
import { SCENE_SCHEMA_VERSION, type DialogueImagePresentation } from '../api/types/semantic-scene';
import type { ResourceAuthoringService } from '../services/resource-authoring';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';

async function makeServices(templates: ProjectTemplateConfiguration, resources?: ResourceAuthoringService) {
  const store = new DocumentStore();
  const coordinator = new SemanticDocumentCoordinator(
    store,
    new SemanticScenePipeline({ resolveAsset: async (source) => `asset://localhost/project/${source}` }),
    { projectPreparedScene: vi.fn(async () => undefined) },
  );
  await coordinator.applyDocument({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'style-defaults',
    meta: { title: 'Style defaults' },
    statements: [{ id: 'existing', type: 'dialogue', time: 0, params: { text: 'Existing', durationSeconds: 1 } }],
  });
  const authoring = new SemanticAuthoringApplicationService(
    store, coordinator, undefined, resources, undefined,
    { getDialogueDefaults: () => templates },
  );
  return { store, authoring };
}

const base = { version: AUTHORING_SCHEMA_VERSION, correlationId: 'new-dialogue', origin: 'timeline-editor' } as const;
const imagePresentation: DialogueImagePresentation = {
  renderer: 'image-dialogue-v1',
  styleId: 'project-image',
  textbox: { image: 'images/textbox.png', x: 100, y: 700, width: 1700, minHeight: 240 },
  text: { x: 150, y: 750, maxWidth: 1600 },
};
const insertionCases: Array<[string, SemanticAuthorIntent]> = [
  ['single dialogue', { ...base, kind: 'insert-statement', anchorTime: 1, statement: { type: 'dialogue', params: { text: 'New', durationSeconds: 1 } } }],
  ['template fragment', { ...base, kind: 'insert-script-segment', anchorTime: 1, statements: [{ type: 'dialogue', params: { text: 'New', durationSeconds: 1 } }] }],
  ['sequential append', { ...base, kind: 'append-sequential-lines', lines: ['First new line', 'Second new line'] }],
  ['dialogue chain insertion', { ...base, kind: 'insert-dialogue-in-chain', text: 'New', beforeStatementId: 'existing' }],
];

describe('project default dialogue style', () => {
  it.each(insertionCases)('applies the builtin default to %s', async (_name, intent) => {
    const { store, authoring } = await makeServices({ enabledTemplateIds: [], dialogueTemplate: 'classic' });
    const receipt = await authoring.author(intent);
    const document = store.getCurrentSceneDocumentSnapshot()!;
    for (const id of receipt.createdStatementIds) {
      expect(document.statements.find((statement) => statement.id === id)?.params).toMatchObject({ template: 'classic' });
      expect(store.getCompiledSceneSnapshot()?.actions.find((action) => action.source.statementId === id)?.params)
        .toMatchObject({ template: 'classic' });
    }
    expect(document.statements.find((statement) => statement.id === 'existing')?.params).not.toHaveProperty('template');
  });

  it.each(insertionCases)('applies the image default to %s', async (_name, intent) => {
    const { store, authoring } = await makeServices({ enabledTemplateIds: [], dialoguePresentation: imagePresentation });
    const receipt = await authoring.author(intent);
    const document = store.getCurrentSceneDocumentSnapshot()!;
    for (const id of receipt.createdStatementIds) {
      const statement = document.statements.find((item) => item.id === id)!;
      expect(statement.params).toMatchObject({ presentation: imagePresentation });
      expect(statement.params).not.toHaveProperty('template');
    }
    expect(document.statements.find((statement) => statement.id === 'existing')?.params).not.toHaveProperty('presentation');
  });

  it('preserves an explicitly selected builtin or image style', async () => {
    const { store, authoring } = await makeServices({ enabledTemplateIds: [], dialoguePresentation: imagePresentation });
    const explicitImage = { ...imagePresentation, styleId: 'explicit-image' };
    const receipt = await authoring.author({
      ...base, kind: 'insert-script-segment', anchorTime: 1,
      statements: [
        { type: 'dialogue', params: { text: 'Builtin', durationSeconds: 1, template: 'minimal' } },
        { type: 'dialogue', time: 1, params: { text: 'Image', durationSeconds: 1, presentation: explicitImage } },
      ],
    });
    const created = store.getCurrentSceneDocumentSnapshot()!.statements
      .filter((statement) => receipt.createdStatementIds.includes(statement.id));
    expect(created[0].params).toMatchObject({ template: 'minimal' });
    expect(created[0].params).not.toHaveProperty('presentation');
    expect(created[1].params).toMatchObject({ presentation: explicitImage });
  });

  it('uses the current default for a transaction and preserves it through undo and redo', async () => {
    const templates: ProjectTemplateConfiguration = { enabledTemplateIds: [], dialogueTemplate: 'classic' };
    const { store, authoring } = await makeServices(templates);
    const first = await authoring.author(insertionCases[0][1]);
    templates.dialogueTemplate = 'minimal';
    const second = await authoring.authorTransaction([
      { ...base, kind: 'append-sequential-lines', lines: ['New default'] },
      { ...base, correlationId: 'chain', kind: 'insert-dialogue-in-chain', text: 'Same default' },
    ]);
    const document = store.getCurrentSceneDocumentSnapshot()!;
    expect(document.statements.find((statement) => statement.id === first.createdStatementIds[0])?.params)
      .toMatchObject({ template: 'classic' });
    for (const id of second.createdStatementIds) {
      expect(document.statements.find((statement) => statement.id === id)?.params).toMatchObject({ template: 'minimal' });
    }
    await authoring.undo();
    expect(store.getCurrentSceneDocumentSnapshot()!.statements).toHaveLength(2);
    templates.dialogueTemplate = 'glass';
    await authoring.redo();
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(document);
  });

  it('keeps edits and duplicated dialogue in their existing style', async () => {
    const { store, authoring } = await makeServices({ enabledTemplateIds: [], dialogueTemplate: 'classic' });
    await authoring.author({
      ...base, kind: 'update-statement', statementId: 'existing',
      patch: { params: { text: 'Edited', durationSeconds: 1 } },
    });
    const editedParams = store.getCurrentSceneDocumentSnapshot()!.statements[0].params;
    const receipt = await authoring.author({ ...base, kind: 'duplicate-statements', statementIds: ['existing'] });
    const duplicate = store.getCurrentSceneDocumentSnapshot()!.statements
      .find((statement) => statement.id === receipt.createdStatementIds[0]);
    expect(duplicate?.params).toEqual(editedParams);
    expect(duplicate?.params).not.toHaveProperty('template');
  });

  it('honors builtin default ids in projects without a materialized renderer field', async () => {
    const { store, authoring } = await makeServices({ enabledTemplateIds: [], defaults: { dialogueStyleId: 'minimal' } });
    const receipt = await authoring.author(insertionCases[0][1]);
    expect(store.getCurrentSceneDocumentSnapshot()!.statements.find((statement) => statement.id === receipt.createdStatementIds[0])?.params)
      .toMatchObject({ template: 'minimal' });
  });

  it('applies the default to AI dialogue and returns the committed style', async () => {
    const { store, authoring } = await makeServices({ enabledTemplateIds: [], dialogueTemplate: 'classic' });
    const result = await authoring.authorAiScriptSegment({
      statements: [{ type: 'dialogue', params: { text: 'AI dialogue', durationSeconds: 1 } }],
      markers: [], issues: [],
    }, 1, 'ai-dialogue');
    expect(result.document).toEqual(store.getCurrentSceneDocumentSnapshot());
    expect(result.document.statements.find((statement) => statement.id === result.receipt.createdStatementIds[0])?.params)
      .toMatchObject({ template: 'classic' });
  });

  it('applies the default when adding a voice resource as dialogue', async () => {
    const resources = {
      resolveAndMaterialize: vi.fn(async () => ({
        reference: 'vocal/new.ogg',
        receipt: {
          input: 'new', key: { kind: 'voice', name: 'new' }, namespace: 'project',
          sourcePath: 'vocal/new.ogg', projectPath: 'vocal/new.ogg',
          operation: 'existing-project-reference', importKind: 'vocal',
        },
      })),
    } as unknown as ResourceAuthoringService;
    const { store, authoring } = await makeServices({ enabledTemplateIds: [], dialogueTemplate: 'classic' }, resources);
    const receipt = await authoring.authorResource({
      selection: { input: 'new', context: { kind: 'voice' } },
      buildIntent: (voice) => ({
        ...base, kind: 'insert-statement', anchorTime: 1,
        statement: { type: 'dialogue', params: { text: 'Voice dialogue', durationSeconds: 1, voice } },
      }),
    });
    expect(store.getCurrentSceneDocumentSnapshot()!.statements.find((statement) => statement.id === receipt.authoring.createdStatementIds[0])?.params)
      .toMatchObject({ voice: 'vocal/new.ogg', template: 'classic' });
  });
});
