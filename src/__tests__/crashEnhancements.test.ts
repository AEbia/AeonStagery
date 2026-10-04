import { describe, it, expect } from 'vitest';
import {
  buildCrashReport,
  formatCrashReportMarkdown,
  setCrashEnvironmentOverride,
  registerSceneSummaryProvider,
} from '../services/crash/CrashReporter';
import { buildRedactedSceneSummary } from '../services/crash/sceneSummary';
import { Logger, getLogBreadcrumbs, clearLogBreadcrumbs } from '../engine/Logger';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';

describe('buildRedactedSceneSummary', () => {
  it('returns null when there is no document', () => {
    expect(buildRedactedSceneSummary(null)).toBeNull();
  });

  it('produces a structural outline and never leaks script text', () => {
    const doc = {
      schemaVersion: 5,
      sceneId: 's1',
      meta: { durationSeconds: 12.5 },
      statements: [
        { id: 'a', time: 0, type: 'dialogue', params: { text: 'secret dialogue' } },
        { id: 'b', time: 2, type: 'action', params: {} },
      ],
    } as unknown as CurrentSceneDocument;

    const summary = buildRedactedSceneSummary(doc);
    expect(summary?.statementCount).toBe(2);
    expect(summary?.durationSeconds).toBe(12.5);
    expect(summary?.outline).toEqual([
      { index: 0, type: 'dialogue', startSeconds: 0, durationSeconds: 2 },
      { index: 1, type: 'action', startSeconds: 2 },
    ]);
    // Raw dialogue text never present; no file path is captured at all.
    expect(JSON.stringify(summary)).not.toContain('secret dialogue');
    expect(JSON.stringify(summary)).not.toContain('projects/scene.json');
  });

  it('caps the outline length but keeps the total count', () => {
    const statements = Array.from({ length: 120 }, (_unused, i) => ({
      id: `s${i}`,
      time: i,
      type: 'dialogue',
      params: {},
    }));
    const doc = {
      schemaVersion: 5,
      sceneId: 's',
      meta: {},
      statements,
    } as unknown as CurrentSceneDocument;

    const summary = buildRedactedSceneSummary(doc);
    expect(summary?.outline.length).toBe(50);
    expect(summary?.statementCount).toBe(120);
  });

  it('enriches the outline with timing and speaker/character (never script text)', () => {
    const doc = {
      schemaVersion: 5,
      sceneId: 's',
      meta: {},
      statements: [
        { id: 'a', time: 0, type: 'dialogue', params: { text: 'secret dialogue', speaker: 'Alice', durationSeconds: 3 } },
        { id: 'b', time: 3, type: 'characterPresence', params: { id: 'char1', mode: 'enter', durationSeconds: 2 } },
        { id: 'c', time: 5, type: 'action', params: {} },
      ],
    } as unknown as CurrentSceneDocument;

    const summary = buildRedactedSceneSummary(doc);
    expect(summary?.outline[0]).toMatchObject({
      index: 0,
      type: 'dialogue',
      startSeconds: 0,
      durationSeconds: 3,
    });
    expect(summary?.outline[1]).toMatchObject({
      index: 1,
      type: 'characterPresence',
      startSeconds: 3,
      durationSeconds: 2,
      characterId: 'char1',
    });
    // Last statement derives duration from the next start (none → omitted).
    expect(summary?.outline[2]).toMatchObject({ index: 2, type: 'action', startSeconds: 5 });
    expect(JSON.stringify(summary)).not.toContain('secret dialogue');
  });
});

describe('CrashReporter enhancements', () => {
  it('merges the environment override and attaches the scene summary', () => {
    setCrashEnvironmentOverride({ electronVersion: '43.1.0', appVersion: '0.6.2' });
    const unregister = registerSceneSummaryProvider(() => ({
      statementCount: 3,
      durationSeconds: 9,
      outline: [{ index: 0, type: 'dialogue', startSeconds: 0 }],
      filePath: null,
    }));

    const report = buildCrashReport({ error: new Error('boom') });
    expect(report.environment.electronVersion).toBe('43.1.0');
    expect(report.environment.appVersion).toBe('0.6.2');
    expect(report.sceneSummary?.statementCount).toBe(3);

    unregister();
    const report2 = buildCrashReport({ error: new Error('boom2') });
    expect(report2.sceneSummary).toBeUndefined();

    setCrashEnvironmentOverride(null);
  });
});

describe('crash report markdown', () => {
  it('includes the redacted, enriched scene summary', () => {
    const report = buildCrashReport({
      error: new Error('boom'),
      sceneSummary: {
        statementCount: 2,
        durationSeconds: 9,
        outline: [
          { index: 0, type: 'dialogue', startSeconds: 0, durationSeconds: 3 },
          { index: 1, type: 'characterPresence', startSeconds: 3, durationSeconds: 2, characterId: 'char1' },
        ],
      },
    });
    const md = formatCrashReportMarkdown(report);
    expect(md).toContain('## Scene Summary (redacted)');
    expect(md).toContain('#0 [dialogue] @0s (3s)');
    expect(md).toContain('#1 [characterPresence] @3s (2s) char=char1');
  });
});

describe('Logger breadcrumb flooding', () => {
  it('excludes trace noise and suppresses consecutive duplicates', () => {
    clearLogBreadcrumbs();
    const log = new Logger('ScriptEngine');
    for (let i = 0; i < 10; i++) log.trace('SEEK to 0.000s', 'color: #ff0;');
    for (let i = 0; i < 10; i++) log.info(`user action ${i}`);

    const bc = getLogBreadcrumbs();
    expect(bc.every((b) => b.level !== 'trace')).toBe(true);
    expect(bc.filter((b) => b.message.includes('SEEK')).length).toBe(0);
    expect(bc.length).toBe(10);
  });

  it('keeps only one of repeated identical breadcrumbs', () => {
    clearLogBreadcrumbs();
    const log = new Logger('PreBakeDaemon');
    log.info('Baking [hot] 0.0s');
    log.info('Baking [hot] 0.0s');
    log.info('Baking [hot] 0.0s');

    const bc = getLogBreadcrumbs();
    expect(bc.length).toBe(1);
    expect(bc[0].message).toBe('Baking [hot] 0.0s');
  });
});
