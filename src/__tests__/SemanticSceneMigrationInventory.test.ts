import { describe, expect, it } from 'vitest';
import {
  LEGACY_ACTION_INVENTORY_IS_EXHAUSTIVE,
  LEGACY_ACTION_NAMES,
  LEGACY_ACTION_MIGRATION_INVENTORY,
  NON_ACTION_MIGRATION_INVENTORY,
  sceneStatementDefinitionRegistry,
} from '../services/semantic-scene';

const ACTION_TYPES = LEGACY_ACTION_NAMES;
describe('semantic scene migration inventory', () => {
  it('covers every current legacy action exactly once', () => {
    expect(LEGACY_ACTION_INVENTORY_IS_EXHAUSTIVE).toBe(true);
    expect(Object.keys(LEGACY_ACTION_MIGRATION_INVENTORY).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('maps migrated actions to known statement families and stable lowerer outputs', () => {
    for (const entry of Object.values(LEGACY_ACTION_MIGRATION_INVENTORY)) {
      const outputKeySet = new Set(entry.lowererOutputKeys);
      expect(outputKeySet.size).toBe(entry.lowererOutputKeys.length);
      expect(entry.lowererOutputKeys.length).toBe(entry.runtimeActions.length);

      if (entry.conclusion === 'migrate' || entry.conclusion === 'runtime-output-only') {
        expect(entry.statementFamily, entry.legacyAction).toBeTruthy();
        expect(sceneStatementDefinitionRegistry.has(entry.statementFamily!), entry.legacyAction).toBe(true);
        expect(entry.newDiscriminator, entry.legacyAction).toBeTruthy();
        expect(entry.lowererOutputKeys.length, entry.legacyAction).toBeGreaterThan(0);
        expect(entry.runtimeActions.length, entry.legacyAction).toBeGreaterThan(0);
      } else {
        expect(entry.statementFamily).toBeUndefined();
        expect(entry.lowererOutputKeys).toEqual([]);
        expect(entry.runtimeActions).toEqual([]);
      }
    }
  });

  it('keeps ADR-deleted source actions out of v3 statement migration', () => {
    expect(LEGACY_ACTION_MIGRATION_INVENTORY.wait).toMatchObject({
      conclusion: 'drop',
      lowererOutputKeys: [],
      runtimeActions: [],
    });
    expect(LEGACY_ACTION_MIGRATION_INVENTORY.custom).toMatchObject({
      conclusion: 'drop',
      lowererOutputKeys: [],
      runtimeActions: [],
    });
  });

  it('marks character rim light as migrated to the accepted visualStyle discriminator', () => {
    expect(LEGACY_ACTION_MIGRATION_INVENTORY.setCharacterRimLight).toMatchObject({
      conclusion: 'migrate',
      statementFamily: 'visualStyle',
      newDiscriminator: 'scope=object slot=rim-light mode=set',
      lowererOutputKeys: ['rim-light'],
      runtimeActions: ['setCharacterRimLight'],
    });
    expect(LEGACY_ACTION_MIGRATION_INVENTORY.setCharacterRimLight.blockers).toBeUndefined();
  });

  it('tracks non-action migration gates called out by KSM-0003', () => {
    expect(NON_ACTION_MIGRATION_INVENTORY.topLevelBgm).toMatchObject({
      conclusion: 'migrate',
      target: expect.stringContaining('role=bgm'),
    });
    expect(NON_ACTION_MIGRATION_INVENTORY.aiPauseStep).toMatchObject({
      conclusion: 'migrate',
      target: expect.stringContaining('meta.durationSeconds'),
    });
    expect(NON_ACTION_MIGRATION_INVENTORY.authoringV1IntentReceipt).toMatchObject({
      conclusion: 'drop',
      target: expect.stringContaining('AUTHORING_SCHEMA_VERSION=3'),
    });
    expect(NON_ACTION_MIGRATION_INVENTORY.collaborationV1WireState).toMatchObject({
      conclusion: 'version-gate',
      target: expect.stringContaining('COLLABORATION_SCHEMA_VERSION=2'),
    });
    expect(NON_ACTION_MIGRATION_INVENTORY.templateAuthoringCombos).toMatchObject({
      conclusion: 'version-gate',
      target: expect.stringContaining('manifestSchemaVersion=2'),
    });
    expect(NON_ACTION_MIGRATION_INVENTORY.visualCompositionContracts).toMatchObject({
      conclusion: 'version-gate',
      target: expect.stringContaining('statement/companion locators'),
    });
  });
});
