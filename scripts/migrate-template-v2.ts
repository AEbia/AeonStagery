import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SceneScript } from './migrations/legacy-scene/LegacySceneTypes';
import { SCENE_SCHEMA_VERSION } from '../src/api/types/semantic-scene';
import { migrateLegacySceneScriptToDocumentV3 } from './migrations/legacy-scene/LegacySceneDocumentMigrator';
import { parseTemplatePackageManifest } from '../src/services/template-package';

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (positional.length < 1 || positional.length > 2) {
    throw new Error('Usage: npm run migrate:template-v2 -- <template-root-or-manifest.json> [output-manifest.v2.json]');
  }
  const inputPath = positional[0].toLowerCase().endsWith('.json')
    ? positional[0]
    : path.join(positional[0], 'manifest.json');
  const outputPath = positional[1] ?? path.join(path.dirname(inputPath), 'manifest.v2.json');
  const raw = JSON.parse(await readFile(inputPath, 'utf8')) as Record<string, any>;
  const parsed = parseTemplatePackageManifest(raw);
  if ((parsed.manifestSchemaVersion ?? 1) === 2) {
    throw new Error('Template manifest is already schema v2');
  }

  const authoringCombos = (parsed.authoringCombos ?? []).map((combo) => {
    if (!combo.actions?.length) {
      throw new Error(`Legacy authoring combo "${combo.id}" has no inline actions to migrate`);
    }
    let time = 0;
    const timeline = combo.actions.flatMap((action) => {
      time += action.delay ?? 0;
      const normalized = normalizeLegacyTemplateAction(action.action, action.params ?? {});
      return normalized ? [{ action: action.action, time, params: normalized }] : [];
    });
    const migration = migrateLegacySceneScriptToDocumentV3({
      sceneId: `template_${combo.id}`,
      meta: { title: combo.name },
      timeline,
    } satisfies SceneScript);
    const errors = migration.issues.filter((issue) => issue.severity === 'error');
    if (!migration.document || errors.length > 0) {
      throw new Error(`Cannot migrate template combo "${combo.id}": ${errors.map((issue) => issue.message).join(' ')}`);
    }
    const statements = migration.document.statements.map(({ id: _id, time: statementTime, ...statement }) => ({
      ...statement,
      ...(statementTime ? { time: statementTime } : {}),
    }));
    const payload = statements.length === 1
      ? { kind: 'statementPreset', statement: statements[0] }
      : { kind: 'timelineFragment', statements };
    return { id: combo.id, name: combo.name, category: combo.category, payload };
  });

  const output = {
    ...raw,
    manifestSchemaVersion: 2,
    template: {
      ...raw.template,
      compatibility: {
        ...(raw.template?.compatibility ?? {}),
        sceneSchemaVersion: SCENE_SCHEMA_VERSION,
      },
    },
    authoringCombos,
  };
  parseTemplatePackageManifest(output);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outputPath}`);
}

function normalizeLegacyTemplateAction(
  action: string,
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  const next = { ...params };
  if (action === 'playMotion' && (typeof next.motion !== 'string' || !next.motion.trim())) {
    return null;
  }
  if (action === 'dialogue' && (typeof next.text !== 'string' || !next.text.trim())) {
    next.text = 'Dialogue';
  }
  if (['addCharacter', 'removeCharacter', 'moveCharacter', 'transformCharacter'].includes(action)) {
    if (typeof next.id !== 'string' || !next.id.trim()) next.id = '$character';
  }
  if (['playMotion', 'setExpression', 'characterLookAt', 'characterBlink', 'setCharacterRimLight'].includes(action)) {
    if (typeof next.id !== 'string' || !next.id.trim()) next.id = '$character';
  }
  return next;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
