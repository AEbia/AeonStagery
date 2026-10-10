import { describe, expect, it } from 'vitest';
import {
  TemplatePackageLoader,
  createLoadedTemplatePackage,
  createTemplatePackageView,
  templateAuthoringComboToSemanticIntent,
  type TemplateAuthoringComboPayload,
} from '../services/template-package';

const visibility = { type: 'dialogueVisibility', params: { visible: false } };
const dialogue = { type: 'dialogue', params: { text: 'Hello', durationSeconds: 2 } };
const payloads: TemplateAuthoringComboPayload[] = [
  { kind: 'statementPreset', statement: visibility },
  { kind: 'timelineFragment', statements: [dialogue, visibility] },
];

function manifest(sceneSchemaVersion: 4 | 5, payload?: TemplateAuthoringComboPayload) {
  return {
    manifestSchemaVersion: 2,
    template: {
      id: 'schema-inheritance', name: 'Schema Inheritance', version: '1.0.0',
      compatibility: { sceneSchemaVersion },
    },
    authoringCombos: [{
      id: 'hide', name: 'Hide', category: 'dialogue',
      ...(payload ? { payload } : { file: 'combos/hide.json' }),
    }],
  };
}

function fileLoader(sceneSchemaVersion: 4 | 5, payload: TemplateAuthoringComboPayload) {
  const files = new Map([
    ['/templates/inheritance/manifest.v2.json', JSON.stringify(manifest(sceneSchemaVersion))],
    ['/templates/inheritance/combos/hide.json', JSON.stringify({ payload })],
  ]);
  return new TemplatePackageLoader({
    readFile: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`Missing test file: ${path}`);
      return { data, path };
    },
    join: async (...parts) => parts.join('/'),
    dirname: async (path) => path.slice(0, path.lastIndexOf('/')),
  });
}

describe('template payload schema inheritance', () => {
  it.each(payloads)('rejects unversioned $kind with v5-only statements in an inline v4 template', (payload) => {
    expect(() => createLoadedTemplatePackage(manifest(4, payload), {
      scope: 'user', packageRoot: '/templates/inheritance',
    })).toThrow(/requires scene schemaVersion 5/);
  });

  it.each(payloads)('rejects unversioned $kind with v5-only statements in a v4 combo file', async (payload) => {
    await expect(fileLoader(4, payload).loadFromPackageRoot('user', '/templates/inheritance'))
      .rejects.toThrow(/requires scene schemaVersion 5/);
  });

  it.each(payloads)('accepts unversioned $kind in inline and file-based v5 templates', async (payload) => {
    const inline = createLoadedTemplatePackage(manifest(5, payload), {
      scope: 'user', packageRoot: '/templates/inheritance',
    });
    const fromFile = await fileLoader(5, payload).loadFromPackageRoot('user', '/templates/inheritance');
    for (const loaded of [inline, fromFile]) {
      const combo = createTemplatePackageView([loaded]).semanticAuthoringCombos[0];
      expect(templateAuthoringComboToSemanticIntent(combo, { anchorTime: 0, correlationId: 'inheritance' }))
        .toMatchObject(payload.kind === 'statementPreset'
          ? { kind: 'insert-statement', statement: visibility }
          : { kind: 'insert-script-segment', statements: [dialogue, visibility] });
    }
  });

  it('keeps existing unversioned v4 dialogue payloads usable', () => {
    const loaded = createLoadedTemplatePackage(manifest(4, { kind: 'statementPreset', statement: dialogue }), {
      scope: 'user', packageRoot: '/templates/inheritance',
    });
    const combo = createTemplatePackageView([loaded]).semanticAuthoringCombos[0];
    expect(templateAuthoringComboToSemanticIntent(combo, { anchorTime: 0, correlationId: 'legacy' }))
      .toMatchObject({ kind: 'insert-statement', statement: dialogue });
  });
});
