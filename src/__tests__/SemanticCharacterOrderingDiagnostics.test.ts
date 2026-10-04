import { describe, expect, it } from 'vitest';
import { sceneDocumentCodec, validateSemanticSceneStructure } from '../services/semantic-scene';
import {
  SEMANTIC_CHARACTER_ORDERING_CODES,
} from '../services/semantic-scene/SemanticSceneValidator';
import {
  SCENE_SCHEMA_VERSION,
  type CurrentSceneDocument,
} from '../api/types/semantic-scene';

function makeDocument(statements: unknown[]): CurrentSceneDocument {
  return sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'semantic-character-ordering',
    meta: {
      title: 'Semantic character ordering diagnostics',
      characters: [
        { id: 'hero', name: 'Hero', model: 'figure/hero/model.json' },
        { id: 'villain', name: 'Villain', model: 'figure/villain/model.json' },
      ],
    },
    statements,
  });
}

function issueFor(
  issues: ReturnType<typeof validateSemanticSceneStructure>,
  code: string,
  actionId: string,
) {
  return issues.find((issue) => issue.code === code && issue.actionId === actionId);
}

describe('semantic character ordering diagnostics', () => {
  it('reports character actions scheduled before the character enters', () => {
    const document = makeDocument([
      {
        id: 'early-motion',
        time: 2,
        type: 'characterPerformance',
        params: { target: 'hero', motion: { kind: 'resource', key: 'wave' } },
      },
      {
        id: 'early-transform',
        time: 3,
        type: 'characterTransform',
        params: { id: 'hero', scale: 1.2 },
      },
      {
        id: 'enter',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
      {
        id: 'ok-motion',
        time: 6,
        type: 'characterPerformance',
        params: { target: 'hero', motion: { kind: 'resource', key: 'nod' } },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance, 'early-motion'))
      .toMatchObject({
        severity: 'error',
        actionType: 'characterPerformance',
        message: expect.stringContaining('登场'),
        location: 'scene.statements["early-motion"]',
      });
    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance, 'early-transform'))
      .toBeDefined();
    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance, 'ok-motion'))
      .toBeUndefined();
  });

  it('allows actions at the same time as the entrance', () => {
    const document = makeDocument([
      {
        id: 'enter',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
      {
        id: 'aligned-motion',
        time: 5,
        type: 'characterPerformance',
        params: { target: 'hero', motion: { kind: 'resource', key: 'wave' } },
      },
      {
        id: 'aligned-transform',
        time: 5,
        type: 'characterTransform',
        params: { id: 'hero', scale: 1.2 },
      },
    ]);

    expect(validateSemanticSceneStructure(document)).toEqual([]);
  });

  it('reports exits before the character enters', () => {
    const document = makeDocument([
      {
        id: 'early-exit',
        time: 1,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'villain' },
      },
      {
        id: 'enter',
        time: 4,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'villain' },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance, 'early-exit'))
      .toMatchObject({
        message: expect.stringContaining('角色退场'),
      });
  });

  it('reports actions when the character never enters', () => {
    const document = makeDocument([
      {
        id: 'orphan-motion',
        time: 0,
        type: 'characterPerformance',
        params: { target: 'villain', motion: { kind: 'resource', key: 'laugh' } },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionWithoutEntrance, 'orphan-motion'))
      .toMatchObject({
        severity: 'warning',
        message: expect.stringContaining('登场'),
      });
  });

  it('reports performance companions under a dialogue that precedes the entrance', () => {
    const document = makeDocument([
      {
        id: 'line',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'hero', text: 'Hello', durationSeconds: 1 },
        companions: [{
          id: 'companion-motion',
          anchor: 'start',
          offset: 0,
          type: 'characterPerformance',
          params: { target: 'hero', motion: { kind: 'resource', key: 'wave' } },
        }],
      },
      {
        id: 'enter',
        time: 3,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance, 'line'))
      .toMatchObject({
        actionType: 'characterPerformance',
        location: 'scene.statements["line"].companions["companion-motion"]',
      });
  });

  it('skips $speaker companions that cannot be resolved without the parent dialogue', () => {
    const document = makeDocument([
      {
        id: 'line',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'hero', text: 'Hello', durationSeconds: 1 },
        companions: [{
          id: 'speaker-motion',
          anchor: 'start',
          offset: 0,
          type: 'characterPerformance',
          params: { target: '$speaker', motion: { kind: 'resource', key: 'wave' } },
        }],
      },
      {
        id: 'enter',
        time: 3,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance, 'line'))
      .toBeUndefined();
  });

  it('reports a second entrance while the character is already on stage', () => {
    const document = makeDocument([
      {
        id: 'enter',
        time: 0,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
      {
        id: 'dup-enter',
        time: 4,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
      {
        id: 'exit',
        time: 8,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'hero' },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.duplicateEntrance, 'dup-enter'))
      .toMatchObject({
        severity: 'error',
        actionType: 'characterPresence',
        message: expect.stringContaining('再次登场'),
        location: 'scene.statements["dup-enter"]',
      });
    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.duplicateEntrance, 'enter'))
      .toBeUndefined();
  });

  it('allows a character to enter again after it has exited', () => {
    const document = makeDocument([
      {
        id: 'enter',
        time: 0,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
      {
        id: 'exit',
        time: 3,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'hero' },
      },
      {
        id: 're-enter',
        time: 6,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.duplicateEntrance, 're-enter'))
      .toBeUndefined();
  });

  it('reports an action placed after an exit but before the next entrance of the same character', () => {
    const document = makeDocument([
      {
        id: 'enter',
        time: 0,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
      {
        id: 'first-motion',
        time: 1,
        type: 'characterPerformance',
        params: { target: 'hero', motion: { kind: 'resource', key: 'wave' } },
      },
      {
        id: 'exit',
        time: 3,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'hero' },
      },
      {
        id: 'gap-motion',
        time: 4,
        type: 'characterPerformance',
        params: { target: 'hero', motion: { kind: 'resource', key: 'nod' } },
      },
      {
        id: 're-enter',
        time: 5,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance, 'gap-motion'))
      .toMatchObject({
        severity: 'error',
        message: expect.stringContaining('下一次登场在第 5 秒'),
      });
    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance, 'first-motion'))
      .toBeUndefined();
  });

  it('reports an action after the last exit when the character never returns', () => {
    const document = makeDocument([
      {
        id: 'enter',
        time: 0,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
      {
        id: 'exit',
        time: 3,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'hero' },
      },
      {
        id: 'late-motion',
        time: 4,
        type: 'characterPerformance',
        params: { target: 'hero', motion: { kind: 'resource', key: 'wave' } },
      },
    ]);

    const issues = validateSemanticSceneStructure(document);

    expect(issueFor(issues, SEMANTIC_CHARACTER_ORDERING_CODES.actionBeforeEntrance, 'late-motion'))
      .toMatchObject({
        severity: 'error',
        message: expect.stringContaining('之后没有再次登场'),
      });
  });

  it('keeps a clean enter/perf/transform/exit lifecycle free of ordering issues', () => {
    const document = makeDocument([
      {
        id: 'enter',
        time: 0,
        type: 'characterPresence',
        params: { mode: 'enter', id: 'hero' },
      },
      {
        id: 'motion',
        time: 1,
        type: 'characterPerformance',
        params: { target: 'hero', motion: { kind: 'resource', key: 'wave' } },
      },
      {
        id: 'transform',
        time: 2,
        type: 'characterTransform',
        params: { id: 'hero', position: [1, 2] },
      },
      {
        id: 'exit',
        time: 3,
        type: 'characterPresence',
        params: { mode: 'exit', id: 'hero' },
      },
    ]);

    expect(validateSemanticSceneStructure(document)).toEqual([]);
  });
});
