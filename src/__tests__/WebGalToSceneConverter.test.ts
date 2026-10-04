import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CurrentSceneDocument,
  SceneStatement,
  StatementParamsByFamily,
} from '../api/types/semantic-scene';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import {
  sceneDocumentCodec,
  sceneStatementCompiler,
} from '../services/semantic-scene';
import { convertWebGalToSceneDocument, joinWebGalScriptTexts } from '../services/import/webgal/WebGalToSceneConverter';

const SAMPLE_SCRIPT = readFileSync(join(process.cwd(), 'src/__tests__/fixtures/webgal-sample-script.txt'), 'utf8');

function statementsOf(document: CurrentSceneDocument, type: SceneStatement['type']): SceneStatement[] {
  return document.statements.filter((statement) => statement.type === type);
}

function firstByType(document: CurrentSceneDocument, type: SceneStatement['type']): SceneStatement {
  const found = statementsOf(document, type);
  expect(found.length).toBeGreaterThan(0);
  return found[0];
}

function paramsOf<T extends SceneStatement['type']>(
  statement: SceneStatement,
  type: T,
): StatementParamsByFamily[T] {
  if (statement.type !== type) throw new Error(`expected ${type} statement`);
  return statement.params as unknown as StatementParamsByFamily[T];
}

describe('convertWebGalToSceneDocument', () => {
  it('imports the real WebGAL sample script into a valid scene document', () => {
    const { document, report } = convertWebGalToSceneDocument(SAMPLE_SCRIPT, {
      mountId: 'webgal-demo',
      sceneTitle: 'MyGO 样例',
    });

    expect(document.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
    expect(document.meta.title).toBe('MyGO 样例');
    expect(document.statements.length).toBeGreaterThan(0);

    // The produced document must survive the strict codec and the compiler.
    expect(() => sceneDocumentCodec.parseAndValidate(document)).not.toThrow();
    expect(() => sceneStatementCompiler.compile(document)).not.toThrow();

    // Every dialogue must carry a positive estimated duration.
    for (const statement of statementsOf(document, 'dialogue')) {
      expect(paramsOf(statement, 'dialogue').durationSeconds).toBeGreaterThan(0);
    }

    // Statements must be ordered by their cursor time.
    const times = document.statements.map((statement) => statement.time);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeGreaterThanOrEqual(times[index - 1]);
    }

    // Characters are derived from model folders and speakers.
    const characterIds = (document.meta.characters ?? []).map((character) => character.id);
    expect(characterIds).toContain('soyo');
    expect(characterIds).toContain('anon');
    const soyo = (document.meta.characters ?? []).find((character) => character.id === 'soyo');
    expect(soyo?.name).toBe('Soyo');

    // Figure references are mounted; backgrounds are mounted too.
    const figureEnter = firstByType(document, 'characterPresence');
    expect(paramsOf(figureEnter, 'characterPresence').model).toMatch(/^@mount\/webgal-demo\/figure\//);
    const background = firstByType(document, 'environmentLayer');
    expect(paramsOf(background, 'environmentLayer').layerId).toBe('background');
    expect(paramsOf(background, 'environmentLayer').file).toMatch(/^@mount\/webgal-demo\/background\//);

    // The report reflects what was converted.
    expect(report.stats.narrationCount + report.stats.dialogueCount).toBeGreaterThan(0);
    expect(report.stats.figureEnters).toBeGreaterThan(0);
    expect(report.stats.figureExits).toBeGreaterThan(0);
    expect(report.stats.backgroundChanges).toBeGreaterThan(0);
  });

  it('keeps project-relative references when no mount id is given', () => {
    const { document } = convertWebGalToSceneDocument('changeBg:A.png;:你好;');
    const background = firstByType(document, 'environmentLayer');
    expect(paramsOf(background, 'environmentLayer').file).toBe('background/A.png');
  });

  it('advances the timeline after a non-next background change', () => {
    const { document } = convertWebGalToSceneDocument('changeBg:A.png;:你好;');
    const [background, dialogue] = document.statements;
    expect(background.time).toBe(0);
    expect(dialogue.time).toBeGreaterThan(0);
  });

  it('chains -next commands at the same time as the following dialogue', () => {
    const { document } = convertWebGalToSceneDocument('changeBg:A.png -next;:你好;');
    const [background, dialogue] = document.statements;
    expect(background.time).toBe(0);
    expect(dialogue.time).toBe(0);
  });

  it('keeps chained -next commands together and advances only after the chain pauses', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeBg:A.png -next;changeBg:B.png;:你好;',
    );
    const [firstBg, secondBg, dialogue] = document.statements;
    expect(firstBg.time).toBe(0);
    expect(secondBg.time).toBe(0);
    expect(dialogue.time).toBeGreaterThan(0);
  });

  it('advances by the full animation duration after a figure exit without -next', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;changeFigure:none -id=1;:之后;',
    );
    const enter = statementsOf(document, 'characterPresence')
      .find((statement) => paramsOf(statement, 'characterPresence').mode === 'enter');
    const exit = statementsOf(document, 'characterPresence')
      .find((statement) => paramsOf(statement, 'characterPresence').mode === 'exit');
    const dialogue = firstByType(document, 'dialogue');
    expect(enter?.time).toBe(0);
    expect(exit?.time).toBeGreaterThan(0);
    expect(dialogue.time).toBeGreaterThanOrEqual(exit!.time + 0.45);
  });

  it('normalizes WebGAL center-relative pixel positions to normalized coordinates', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -transform={"position":{"x":-400},"scale":{"x":0.8,"y":0.8}};',
    );
    const enter = firstByType(document, 'characterPresence');
    const params = paramsOf(enter, 'characterPresence');
    expect(params.position?.[0]).toBeCloseTo(0.5 - 400 / 2560, 5);
    expect(params.position?.[1]).toBeCloseTo(1, 5);
    expect(params.scale).toBeCloseTo(1.1, 5);
  });

  it('keeps characters standing at the stage bottom when no y is given', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -transform={"position":{"x":400}};',
    );
    const enter = firstByType(document, 'characterPresence');
    const params = paramsOf(enter, 'characterPresence');
    expect(params.position?.[0]).toBeCloseTo(0.5 + 400 / 2560, 5);
    expect(params.position?.[1]).toBeCloseTo(1, 5);
  });

  it('gives characters without a position the standing default instead of the screen center', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:tomori/model.json -id=4 -transform={"scale":{"x":0.8,"y":0.8}};',
    );
    const enter = firstByType(document, 'characterPresence');
    const params = paramsOf(enter, 'characterPresence');
    expect(params.position?.[0]).toBeCloseTo(0.5, 5);
    expect(params.position?.[1]).toBeCloseTo(1, 5);
  });

  it('maps setTransform pixel offsets to normalized coordinates with only x given', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:anon/model.json -id=2;'
      + 'setTransform:{"position":{"x":400},"alpha":0.9} -duration=500 -target=2;',
    );
    const transform = firstByType(document, 'characterTransform');
    const params = paramsOf(transform, 'characterTransform');
    expect(params.position?.[0]).toBeCloseTo(0.5 + 400 / 2560, 5);
    expect(params.position?.[1]).toBeCloseTo(1, 5);
  });

  it('treats a motion-only changeFigure on a present character as a performance, not a re-enter', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -transform={"position":{"x":-400}};'
      + 'changeFigure:soyo/model.json -id=1 -motion=soyo/m1;'
      + 'changeFigure:anon/model.json -id=2 -transform={"position":{"x":400}};',
    );
    const soyoEnters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').id === 'soyo'
        && paramsOf(statement, 'characterPresence').mode === 'enter');
    expect(soyoEnters).toHaveLength(1);
    expect(paramsOf(soyoEnters[0], 'characterPresence').position?.[0]).toBeCloseTo(0.5 - 400 / 2560, 5);
    const motionUpdate = statementsOf(document, 'characterPerformance')
      .find((statement) => paramsOf(statement, 'characterPerformance').target === 'soyo');
    expect(paramsOf(motionUpdate!, 'characterPerformance').motion).toEqual({ kind: 'resource', key: 'soyo/m1' });
    const anon = statementsOf(document, 'characterPresence')
      .find((statement) => paramsOf(statement, 'characterPresence').id === 'anon');
    expect(paramsOf(anon!, 'characterPresence').position?.[0]).toBeCloseTo(0.5 + 400 / 2560, 5);
  });

  it('places a re-entered character fresh at the default when no transform is given', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -transform={"position":{"x":-400}};'
      + 'changeFigure: -id=1;'
      + 'changeFigure:soyo/model.json -id=1 -motion=soyo/m1;',
    );
    const soyoEnters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').id === 'soyo'
        && paramsOf(statement, 'characterPresence').mode === 'enter');
    expect(soyoEnters).toHaveLength(2);
    const reentry = soyoEnters[1];
    expect(paramsOf(reentry, 'characterPresence').position?.[0]).toBeCloseTo(0.5, 5);
  });

  it('does not re-enter a present character when the model is unchanged', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;'
      + 'changeFigure:soyo/model.json -id=1 -expression=soyo/e1;'
      + 'changeFigure:soyo/model.json -id=1 -expression=soyo/e2;',
    );
    const soyoEnters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').id === 'soyo'
        && paramsOf(statement, 'characterPresence').mode === 'enter');
    expect(soyoEnters).toHaveLength(1);
    expect(report.stats.figureEnters).toBe(1);
  });

  it('re-models a present character when the figure path changes', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'changeFigure:soyo/school_winter/model.json -id=1 -transform={"position":{"x":-400}};'
      + 'changeFigure:soyo/live_default/model.json -id=1;',
    );
    const soyoEnters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').id === 'soyo'
        && paramsOf(statement, 'characterPresence').mode === 'enter');
    expect(soyoEnters).toHaveLength(2);
    const remodel = soyoEnters[1];
    expect(paramsOf(remodel, 'characterPresence').model).toBe('figure/soyo/live_default/model.json');
    expect(paramsOf(remodel, 'characterPresence').position?.[0]).toBeCloseTo(0.5 - 400 / 2560, 5);
    expect(report.stats.figureEnters).toBe(2);
  });

  it('binds a dialogue that precedes its figure to the same character', () => {
    const { document } = convertWebGalToSceneDocument(
      'Soyo:你好 -figureId=1;'
      + 'changeFigure:soyo/model.json -id=1;',
    );
    const dialogue = firstByType(document, 'dialogue');
    expect(paramsOf(dialogue, 'dialogue').speakerId).toBe('soyo');
    const soyo = (document.meta.characters ?? []).find((character) => character.id === 'soyo');
    expect(soyo?.model).toMatch(/^figure\/soyo\/model\.json$/);
    const characterIds = (document.meta.characters ?? []).map((character) => character.id);
    expect(characterIds).not.toContain('soyo_2');
    const soyoEnters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').id === 'soyo');
    expect(soyoEnters).toHaveLength(1);
  });

  it('binds a dialogue without any figure flag to the character its figure introduced', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;Soyo:你好;',
    );
    const dialogue = firstByType(document, 'dialogue');
    expect(paramsOf(dialogue, 'dialogue').speakerId).toBe('soyo');
    const characters = document.meta.characters ?? [];
    expect(characters.map((character) => character.id)).toEqual(['soyo']);
    expect(characters[0].name).toBe('Soyo');
    const soyoEnters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').id === 'soyo');
    expect(soyoEnters).toHaveLength(1);
  });

  it('binds a figure entering after its speaker to the speaker character', () => {
    const { document } = convertWebGalToSceneDocument(
      'Soyo:你好;changeFigure:soyo/model.json -id=1;',
    );
    const dialogue = firstByType(document, 'dialogue');
    expect(paramsOf(dialogue, 'dialogue').speakerId).toBe('soyo');
    const soyo = (document.meta.characters ?? []).find((character) => character.id === 'soyo');
    expect(soyo?.model).toMatch(/^figure\/soyo\/model\.json$/);
    expect((document.meta.characters ?? []).map((character) => character.id)).toEqual(['soyo']);
    const enters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').mode === 'enter');
    expect(enters).toHaveLength(1);
    expect(paramsOf(enters[0], 'characterPresence').id).toBe('soyo');
  });

  it('keeps two explicit -id instances of the same model as separate characters', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;changeFigure:soyo/model.json -id=2;',
    );
    const characterIds = (document.meta.characters ?? []).map((character) => character.id);
    expect(characterIds).toEqual(['soyo', 'soyo_2']);
    const enters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').mode === 'enter');
    expect(enters).toHaveLength(2);
  });

  it('reuses the model-derived character when changeFigure repeats without -id', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json;changeFigure:soyo/model.json -motion=soyo/m1;',
    );
    expect((document.meta.characters ?? []).map((character) => character.id)).toEqual(['soyo']);
    const enters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').mode === 'enter');
    expect(enters).toHaveLength(1);
    const performance = statementsOf(document, 'characterPerformance')
      .find((statement) => paramsOf(statement, 'characterPerformance').target === 'soyo');
    expect(paramsOf(performance!, 'characterPerformance').motion).toEqual({ kind: 'resource', key: 'soyo/m1' });
  });

  it('maps -zIndex to the character z layer', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;'
      + 'changeFigure:anon/model.json -id=2 -zIndex=1;',
    );
    const anon = statementsOf(document, 'characterPresence')
      .find((statement) => paramsOf(statement, 'characterPresence').id === 'anon');
    expect(paramsOf(anon!, 'characterPresence').z).toBe(1);
  });

  it('attaches a bare -path.wav flag to the dialogue voice', () => {
    const { document } = convertWebGalToSceneDocument(
      'Soyo:你好 -soyo/20260101_hello.wav -figureId=1;',
      { mountId: 'webgal-demo' },
    );
    const dialogue = firstByType(document, 'dialogue');
    expect(paramsOf(dialogue, 'dialogue').voice).toBe('@mount/webgal-demo/vocal/soyo/20260101_hello.wav');
  });

  it('reports un-mounted voices as a note and keeps an estimate', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'Soyo:你好 -soyo/20260101_hello.wav -figureId=1;',
    );
    const dialogue = firstByType(document, 'dialogue');
    expect(paramsOf(dialogue, 'dialogue').voice).toBe('vocal/soyo/20260101_hello.wav');
    expect(report.notes.some((note) => note.message.includes('配音'))).toBe(true);
  });

  it('scales estimated durations by the reading speed', () => {
    const script = ':很长的一段旁白文字，用来测试阅读速度对估算时长的影响。;';
    const slow = convertWebGalToSceneDocument(script, { duration: { speed: 0.5 } });
    const fast = convertWebGalToSceneDocument(script, { duration: { speed: 2 } });
    const slowDialogue = firstByType(slow.document, 'dialogue');
    const fastDialogue = firstByType(fast.document, 'dialogue');
    expect(paramsOf(fastDialogue, 'dialogue').durationSeconds).toBeLessThan(
      paramsOf(slowDialogue, 'dialogue').durationSeconds,
    );
  });

  it('keeps separate positions for multiple re-entered characters', () => {
    const script = [
      'changeFigure:tomori/model.json -id=4 -transform={"scale":{"x":0.8,"y":0.8}};',
      'changeFigure:taki/model.json -id=3 -transform={"position":{"x":850},"scale":{"x":0.8,"y":0.8}};',
      'changeFigure:rana/model.json -id=5 -transform={"position":{"x":450},"scale":{"x":0.8,"y":0.8}};',
      'changeFigure:tomori/model.json -id=4 -motion=tomori/m1;',
      'changeFigure:taki/model.json -id=3 -motion=taki/m1;',
      'changeFigure:rana/model.json -id=5 -motion=rana/m1;',
    ].join('\n');
    const { document } = convertWebGalToSceneDocument(script);
    const enters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').mode === 'enter');
    const positionXById = new Map<string, number>();
    for (const statement of enters) {
      const params = paramsOf(statement, 'characterPresence');
      positionXById.set(params.id, params.position?.[0] ?? 0.5);
    }
    // Re-entered characters must keep distinct horizontal positions, not stack.
    expect(positionXById.get('taki')).toBeCloseTo(0.5 + 850 / 2560, 5);
    expect(positionXById.get('rana')).toBeCloseTo(0.5 + 450 / 2560, 5);
    expect(positionXById.get('tomori')).toBeCloseTo(0.5, 5);
  });

  it('does not carry a low alpha across an exit and re-entry (no ghost)', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:taki/model.json -id=3 -transform={"position":{"x":400},"alpha":0.75};'
      + 'changeFigure:none -id=3;'
      + 'changeFigure:taki/model.json -id=3 -transform={"position":{"x":850},"scale":{"x":0.8,"y":0.8}};',
    );
    const takiEntries = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').id === 'taki'
        && paramsOf(statement, 'characterPresence').mode === 'enter');
    const reentry = takiEntries[takiEntries.length - 1];
    const params = paramsOf(reentry, 'characterPresence');
    expect(params.opacity).toBeUndefined();
    expect(params.position?.[0]).toBeCloseTo(0.5 + 850 / 2560, 5);
  });

  it('maps figure ids to speakers through -figureId', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;Soyo:你好 -figureId=1;',
    );
    const dialogue = firstByType(document, 'dialogue');
    expect(paramsOf(dialogue, 'dialogue').speakerId).toBe('soyo');
    expect(paramsOf(dialogue, 'dialogue').speaker).toBe('Soyo');
    const soyo = (document.meta.characters ?? []).find((character) => character.id === 'soyo');
    expect(soyo?.model).toMatch(/^figure\/soyo\/model\.json$/);
  });

  it('converts changeFigure:none into a character exit', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;changeFigure:none -id=1;',
    );
    const exit = statementsOf(document, 'characterPresence')
      .find((statement) => paramsOf(statement, 'characterPresence').mode === 'exit');
    expect(exit).toBeDefined();
    expect(paramsOf(exit!, 'characterPresence').id).toBe('soyo');
  });

  it('converts setTransform into a character transform', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:anon/model.json -id=2;'
      + 'setTransform:{"position":{"x":400},"alpha":0.9} -duration=500 -target=2;',
    );
    const transform = firstByType(document, 'characterTransform');
    expect(paramsOf(transform, 'characterTransform').id).toBe('anon');
    expect(paramsOf(transform, 'characterTransform').opacity).toBe(0.9);
    expect(paramsOf(transform, 'characterTransform').durationSeconds).toBe(0.5);
  });

  it('skips setTransform when its target figure is unknown', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'setTransform:{"position":{"x":400}} -duration=500 -target=missing;',
    );
    expect(statementsOf(document, 'characterTransform')).toHaveLength(0);
    expect(document.meta.characters).toHaveLength(0);
    expect(report.notes.some((note) => note.message.includes('找不到目标立绘'))).toBe(true);
  });

  it('converts motion and expression into a character performance', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -motion=soyo/m1 -expression=soyo/e1;',
    );
    const performance = firstByType(document, 'characterPerformance');
    expect(paramsOf(performance, 'characterPerformance').target).toBe('soyo');
    expect(paramsOf(performance, 'characterPerformance').motion).toEqual({ kind: 'resource', key: 'soyo/m1' });
    expect(paramsOf(performance, 'characterPerformance').expression).toBe('soyo/e1');
  });

  it('converts blink interval from milliseconds to seconds', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -blink={"blinkInterval":5000};',
    );
    const performance = firstByType(document, 'characterPerformance');
    expect(paramsOf(performance, 'characterPerformance').blink).toEqual({ enabled: true, interval: 5 });
  });

  it('converts -focus into a character lookAt gaze point', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -focus={"x":0.6,"y":-0.2};',
    );
    const performance = firstByType(document, 'characterPerformance');
    const params = paramsOf(performance, 'characterPerformance');
    expect(params.lookAt).toEqual({ enabled: true, point: [0.6, -0.2] });
    expect(statementsOf(document, 'camera')).toHaveLength(0);
    expect(report.notes.some((note) => note.message.includes('lookAt'))).toBe(true);
  });

  it('places -left and -right figures at the stage sides', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -left;'
      + 'changeFigure:anon/model.json -id=2 -right;',
    );
    const xById = new Map<string, number | undefined>();
    for (const statement of statementsOf(document, 'characterPresence')) {
      const params = paramsOf(statement, 'characterPresence');
      xById.set(params.id, params.position?.[0]);
    }
    expect(xById.get('soyo')).toBeCloseTo(0.2, 5);
    expect(xById.get('anon')).toBeCloseTo(0.8, 5);
  });

  it('defaults -left / -right figures to the fig-left / fig-right ids', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -left;'
      + 'changeFigure:soyo/model.json -right;',
    );
    // The side ids are bound to their model characters, so the two side
    // figures never collapse into one character.
    expect((document.meta.characters ?? []).map((character) => character.id)).toEqual(
      ['soyo', 'soyo_2'],
    );
    const enters = statementsOf(document, 'characterPresence')
      .filter((statement) => paramsOf(statement, 'characterPresence').mode === 'enter');
    expect(enters).toHaveLength(2);
  });

  it('keeps multi-speaker dialogue as display text without creating a character', () => {
    const { document } = convertWebGalToSceneDocument('Anon & Soyo:感谢大家！;');
    const dialogue = firstByType(document, 'dialogue');
    expect(paramsOf(dialogue, 'dialogue').speaker).toBe('Anon & Soyo');
    expect(paramsOf(dialogue, 'dialogue').speakerId).toBeUndefined();
    const characterIds = (document.meta.characters ?? []).map((character) => character.id);
    expect(characterIds).not.toContain('anon-soyo');
  });

  it('reports unsupported commands and keeps converting the rest', () => {
    const { document, report } = convertWebGalToSceneDocument('playVideo:movie.mp4;:台词;');
    expect(report.unsupportedCommands.some((entry) => entry.command === 'playvideo')).toBe(true);
    expect(statementsOf(document, 'dialogue')).toHaveLength(1);
  });

  it('maps WebGAL -position presets to normalized x positions', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -position=left -id=1;'
      + 'changeFigure:anon/model.json -position=right13 -id=2;'
      + 'changeFigure:taki/model.json -position=center -id=3;',
    );
    const xById = new Map<string, number | undefined>();
    for (const statement of statementsOf(document, 'characterPresence')) {
      const params = paramsOf(statement, 'characterPresence');
      xById.set(params.id, params.position?.[0]);
    }
    expect(xById.get('soyo')).toBeCloseTo(0.2, 5);
    expect(xById.get('anon')).toBeCloseTo(2 / 3, 5);
    expect(xById.get('taki')).toBeCloseTo(0.5, 5);
  });

  it('treats an empty changeFigure content as a figure exit', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;changeFigure: -id=1;',
    );
    const exit = statementsOf(document, 'characterPresence')
      .find((statement) => paramsOf(statement, 'characterPresence').mode === 'exit');
    expect(exit).toBeDefined();
    expect(paramsOf(exit!, 'characterPresence').id).toBe('soyo');
  });

  it('converts an empty changeBg into a background removal', () => {
    const { document, report } = convertWebGalToSceneDocument('changeBg:none;:台词;');
    const environment = statementsOf(document, 'environmentLayer');
    expect(environment).toHaveLength(1);
    expect(paramsOf(environment[0], 'environmentLayer')).toMatchObject({
      mode: 'remove',
      layerId: 'background',
    });
    expect(statementsOf(document, 'dialogue')).toHaveLength(1);
    expect(report.stats.backgroundChanges).toBe(0);
  });

  it('falls back to -id when a dialogue lacks -figureId', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;Soyo:你好 -id=1;',
    );
    const dialogue = firstByType(document, 'dialogue');
    expect(paramsOf(dialogue, 'dialogue').speakerId).toBe('soyo');
  });

  it('records flow-control commands as unsupported instead of dialogue', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'setVar:chapter=1;choose:选项一;jumpLabel:next;:台词;',
    );
    expect(report.unsupportedCommands.map((entry) => entry.command)).toEqual(
      expect.arrayContaining(['setvar', 'choose', 'jumplabel']),
    );
    expect(statementsOf(document, 'dialogue')).toHaveLength(1);
  });

  it('never turns visual or audio commands into dialogue lines', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'pixiPerform:rain;'
      + 'miniAvatar:char_a/avatar.png;'
      + 'getUserInput:name;'
      + 'filmMode:on;'
      + ':只有这一句台词;',
    );
    const dialogue = statementsOf(document, 'dialogue');
    expect(dialogue).toHaveLength(1);
    const speakers = dialogue.map((statement) => paramsOf(statement, 'dialogue').speaker);
    expect(speakers).not.toContain('pixiPerform');
    expect(speakers).not.toContain('miniAvatar');
    expect(speakers).not.toContain('getUserInput');
    expect(speakers).not.toContain('filmMode');
    expect(report.unsupportedCommands.map((entry) => entry.command)).toEqual(
      expect.arrayContaining(['pixiperform', 'miniavatar', 'getuserinput', 'filmmode']),
    );
  });

  it('converts bgm into a looping music statement without blocking the timeline', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'bgm:music/bgm.ogg;:台词;',
      { mountId: 'webgal-demo' },
    );
    const audio = firstByType(document, 'audio');
    const params = paramsOf(audio, 'audio');
    expect(params).toMatchObject({ role: 'bgm', mode: 'play' });
    if (params.role !== 'bgm' || params.mode !== 'play') throw new Error('expected bgm play');
    expect(params.file).toBe('@mount/webgal-demo/music/bgm.ogg');
    expect(params.loop).toBe(true);
    expect(report.stats.bgmCount).toBe(1);
    // Music is instantaneous: the following line starts at the same time.
    const dialogue = firstByType(document, 'dialogue');
    expect(dialogue.time).toBe(0);
  });

  it('maps bgm volume and fade-in flags', () => {
    const { document } = convertWebGalToSceneDocument('bgm:music/bgm.ogg -volume=50 -enter=1000;');
    const audio = firstByType(document, 'audio');
    const params = paramsOf(audio, 'audio');
    if (params.role !== 'bgm' || params.mode !== 'play') throw new Error('expected bgm play');
    expect(params.volume).toBeCloseTo(0.5, 5);
    expect(params.fadeIn).toBe(1);
  });

  it('converts bgm:none and stopBgm into a music stop', () => {
    const { document } = convertWebGalToSceneDocument('bgm:music/bgm.ogg;bgm:none;stopBgm;');
    const audio = statementsOf(document, 'audio');
    expect(audio).toHaveLength(3);
    const stops = audio.filter((statement) => {
      const params = paramsOf(statement, 'audio');
      return params.role === 'bgm' && params.mode === 'stop';
    });
    expect(stops).toHaveLength(2);
  });

  it('routes legacy playBgm into the same music statement', () => {
    const { document } = convertWebGalToSceneDocument('playBgm:music/old.ogg;');
    const audio = firstByType(document, 'audio');
    expect(paramsOf(audio, 'audio')).toMatchObject({ role: 'bgm', mode: 'play' });
  });

  it('converts playEffect with an id into a looping stacked sound effect', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'playEffect:rain.wav -id=rain -volume=60;',
      { mountId: 'webgal-demo' },
    );
    const audio = firstByType(document, 'audio');
    const params = paramsOf(audio, 'audio');
    if (params.role !== 'sfx' || params.mode !== 'play') throw new Error('expected sfx play');
    expect(params.instanceId).toBe('rain');
    expect(params.file).toBe('@mount/webgal-demo/rain.wav');
    expect(params.loop).toBe(true);
    expect(params.volume).toBeCloseTo(0.6, 5);
    expect(report.stats.sfxCount).toBe(1);
  });

  it('converts an id-less playEffect into the default effect channel', () => {
    const { document } = convertWebGalToSceneDocument('playEffect:thunder.wav;');
    const audio = firstByType(document, 'audio');
    const params = paramsOf(audio, 'audio');
    if (params.role !== 'sfx' || params.mode !== 'play') throw new Error('expected sfx play');
    expect(params.instanceId).toBe('webgal-sfx');
    expect(params.loop).toBeUndefined();
  });

  it('converts playEffect:none and stopEffect into effect stops', () => {
    const { document } = convertWebGalToSceneDocument(
      'playEffect:rain.wav -id=rain;playEffect:none -id=rain;stopEffect;',
    );
    const audio = statementsOf(document, 'audio');
    const stops = audio.filter((statement) => {
      const params = paramsOf(statement, 'audio');
      return params.role === 'sfx' && params.mode === 'stop';
    });
    expect(stops).toHaveLength(2);
    const first = paramsOf(stops[0], 'audio');
    if (first.role !== 'sfx') throw new Error('expected sfx');
    expect(first.instanceId).toBe('rain');
    const second = paramsOf(stops[1], 'audio');
    if (second.role !== 'sfx') throw new Error('expected sfx');
    expect(second.instanceId).toBe('webgal-sfx');
  });

  it('accepts the documented -vocal voice flag', () => {
    const { document } = convertWebGalToSceneDocument(
      'Soyo:你好 -vocal=soyo/20260101_hello.wav -figureId=1;',
      { mountId: 'webgal-demo' },
    );
    const dialogue = firstByType(document, 'dialogue');
    expect(paramsOf(dialogue, 'dialogue').voice).toBe('@mount/webgal-demo/vocal/soyo/20260101_hello.wav');
  });

  it('maps changeBg duration and ease flags', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeBg:A.png -duration=2000 -ease=easeOut;',
    );
    const background = firstByType(document, 'environmentLayer');
    const params = paramsOf(background, 'environmentLayer');
    expect(params.durationSeconds).toBe(2);
    expect(params.ease).toBe('easeout');
  });

  it('maps changeBg enter/exit durations separately', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeBg:A.png -enterDuration=800;changeBg:none -exitDuration=1200;',
    );
    const environment = statementsOf(document, 'environmentLayer');
    expect(paramsOf(environment[0], 'environmentLayer').durationSeconds).toBe(0.8);
    expect(paramsOf(environment[1], 'environmentLayer').durationSeconds).toBe(1.2);
  });

  it('maps changeFigure duration and ease onto the entrance', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -duration=600 -ease=backOut;',
    );
    const enter = firstByType(document, 'characterPresence');
    const params = paramsOf(enter, 'characterPresence');
    expect(params.durationSeconds).toBe(0.6);
    expect(params.ease).toBe('back.out(1.7)');
  });

  it('maps changeFigure exit duration onto the exit', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;changeFigure:none -id=1 -exitDuration=900;',
    );
    const exit = statementsOf(document, 'characterPresence')
      .find((statement) => paramsOf(statement, 'characterPresence').mode === 'exit');
    expect(paramsOf(exit!, 'characterPresence').durationSeconds).toBe(0.9);
  });

  it('maps setTransform ease and duration', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:anon/model.json -id=2;'
      + 'setTransform:{"position":{"x":400}} -duration=800 -ease=circInOut -target=2;',
    );
    const transform = firstByType(document, 'characterTransform');
    const params = paramsOf(transform, 'characterTransform');
    expect(params.durationSeconds).toBe(0.8);
    expect(params.ease).toBe('circ.inOut');
  });

  it('maps character transform filters into lighting post processing', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 '
      + '-transform={"brightness":0.5,"saturation":0.8,"colorRed":227,"colorGreen":213,"colorBlue":193};',
    );
    const post = statementsOf(document, 'lighting')
      .find((statement) => paramsOf(statement, 'lighting').effect === 'post');
    expect(post).toBeDefined();
    const params = paramsOf(post!, 'lighting');
    if (params.effect !== 'post') throw new Error('expected post');
    expect(params.adjBrightness).toBe(0.5);
    expect(params.adjSaturation).toBe(0.8);
    expect(params.adjRed).toBeCloseTo(227 / 255, 5);
    expect(params.adjGreen).toBeCloseTo(213 / 255, 5);
    expect(params.adjBlue).toBeCloseTo(193 / 255, 5);
  });

  it('maps character blur onto characters-targeted lighting blur', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 -transform={"blur":10};',
    );
    const blur = statementsOf(document, 'lighting')
      .find((statement) => paramsOf(statement, 'lighting').effect === 'blur');
    const params = paramsOf(blur!, 'lighting');
    if (params.effect !== 'blur') throw new Error('expected blur');
    expect(params.target).toBe('characters');
    expect(params.intensity).toBe(1);
  });

  it('maps background blur onto background-targeted lighting blur', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeBg:A.png -transform={"blur":20};',
    );
    const blur = statementsOf(document, 'lighting')
      .find((statement) => paramsOf(statement, 'lighting').effect === 'blur');
    const params = paramsOf(blur!, 'lighting');
    if (params.effect !== 'blur') throw new Error('expected blur');
    expect(params.target).toBe('background');
  });

  it('maps bevel onto the character rim-light edge light', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 '
      + '-transform={"bevel":1,"bevelThickness":8,"bevelRed":255,"bevelGreen":183,"bevelBlue":0,"bevelRotation":30,"bevelSoftness":0.8};',
    );
    const rim = statementsOf(document, 'visualStyle')
      .find((statement) => paramsOf(statement, 'visualStyle').slot === 'rim-light');
    expect(rim).toBeDefined();
    const params = paramsOf(rim!, 'visualStyle');
    if (params.slot !== 'rim-light') throw new Error('expected rim-light');
    expect(params.target).toBe('soyo');
    expect(params.intensity).toBe(1);
    expect(params.thickness).toBe(8);
    expect(params.color).toBe('#ffb700');
    expect(params.angle).toBe(30);
    expect(params.softness).toBe(0.8);
  });

  it('maps bloom, rgbFilm and godrayFilm onto lighting statements', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 '
      + '-transform={"bloom":1,"bloomThreshold":0.8,"rgbFilm":1,"godrayFilm":1};',
    );
    const lighting = statementsOf(document, 'lighting');
    const post = lighting.find((statement) => paramsOf(statement, 'lighting').effect === 'post');
    const postParams = paramsOf(post!, 'lighting');
    if (postParams.effect !== 'post') throw new Error('expected post');
    expect(postParams.bloomThreshold).toBe(0.8);
    expect(postParams.bloomBrightness).toBe(1);
    expect(postParams.rgbSplitX).toBeGreaterThan(0);
    const godrays = lighting.find((statement) => paramsOf(statement, 'lighting').effect === 'godrays');
    expect(godrays).toBeDefined();
  });

  it('reports dropped filters instead of silently losing them', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1 '
      + '-transform={"glitchFilm":1,"mysteryField":3};',
    );
    expect(statementsOf(document, 'visualStyle')).toHaveLength(0);
    expect(report.notes.some((note) => note.message.includes('glitchFilm'))).toBe(true);
    expect(report.notes.some((note) => note.message.includes('mysteryField'))).toBe(true);
  });

  it('unfolds setTempAnimation keyframes into consecutive transforms', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;'
      + 'setTempAnimation:[{"duration":0},{"position":{"x":500},"duration":500,"ease":"bounceOut"},{"rotation":0.3,"duration":300}] -target=1;',
    );
    const transforms = statementsOf(document, 'characterTransform');
    expect(transforms).toHaveLength(2);
    const first = paramsOf(transforms[0], 'characterTransform');
    expect(first.durationSeconds).toBe(0.5);
    expect(first.position?.[0]).toBeCloseTo(0.5 + 500 / 2560, 5);
    expect(first.ease).toBe('bounce.out');
    const second = paramsOf(transforms[1], 'characterTransform');
    expect(second.rotation).toBe(0.3);
    expect(second.durationSeconds).toBe(0.3);
  });

  it('reports filter frames inside setTempAnimation', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;'
      + 'setTempAnimation:[{"duration":0},{"blur":10,"duration":200}] -target=1;',
    );
    expect(report.notes.some((note) => note.message.includes('滤镜'))).toBe(true);
    const transforms = statementsOf(document, 'characterTransform');
    expect(transforms).toHaveLength(0);
  });

  it('converts setComplexAnimation soft fades', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;'
      + 'setComplexAnimation:universalSoftOff -target=1 -duration=1000;'
      + 'setComplexAnimation:universalSoftIn -target=1 -duration=1000;',
    );
    const transforms = statementsOf(document, 'characterTransform');
    expect(transforms).toHaveLength(2);
    expect(paramsOf(transforms[0], 'characterTransform').opacity).toBe(0);
    expect(paramsOf(transforms[1], 'characterTransform').opacity).toBe(1);
  });

  it('applies setTransition presets to the next figure entrance', () => {
    const { document } = convertWebGalToSceneDocument(
      'setTransition: -target=1 -enter=enter-from-left;'
      + 'changeFigure:soyo/model.json -id=1;',
    );
    const enter = firstByType(document, 'characterPresence');
    const params = paramsOf(enter, 'characterPresence');
    expect(params.transition).toBe('slideFromLeft');
  });

  it('applies setTransition presets to figure exits and backgrounds', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeFigure:soyo/model.json -id=1;'
      + 'setTransition: -target=1 -exit=exit-to-right;'
      + 'changeFigure:none -id=1;'
      + 'setTransition: -target=bg-main -enter=enter-from-right;'
      + 'changeBg:A.png;',
    );
    const exit = statementsOf(document, 'characterPresence')
      .find((statement) => paramsOf(statement, 'characterPresence').mode === 'exit');
    expect(paramsOf(exit!, 'characterPresence').transition).toBe('slideToRight');
    const background = firstByType(document, 'environmentLayer');
    expect(paramsOf(background, 'environmentLayer').transition).toBe('crossFade');
  });

  it('converts intro into a full-screen text layer with a timed removal', () => {
    const { document } = convertWebGalToSceneDocument('intro:第一行|第二行|第三行;:之后;');
    const textLayers = statementsOf(document, 'graphicLayer')
      .filter((statement) => paramsOf(statement, 'graphicLayer').kind === 'text');
    expect(textLayers).toHaveLength(2);
    const set = textLayers.find((statement) => paramsOf(statement, 'graphicLayer').mode === 'set');
    const remove = textLayers.find((statement) => paramsOf(statement, 'graphicLayer').mode === 'remove');
    const setParams = paramsOf(set!, 'graphicLayer');
    if (setParams.kind !== 'text') throw new Error('expected text layer');
    expect(setParams.text).toBe('第一行\n第二行\n第三行');
    expect(setParams.id).toBe('webgal-intro');
    // 3 lines × 1500ms default delay = 4.5s hold, then the layer is removed.
    expect(set!.time).toBe(0);
    expect(remove!.time).toBeCloseTo(4.5, 5);
    // The following line starts after the intro finishes.
    const dialogue = firstByType(document, 'dialogue');
    expect(dialogue.time).toBeGreaterThanOrEqual(4.5);
  });

  it('honors intro fontSize, fontColor, delayTime and hold', () => {
    const { document } = convertWebGalToSceneDocument(
      'intro:一段话 -fontSize=large -fontColor=rgba(255,255,255,1) -delayTime=2000 -hold;',
    );
    const textSet = statementsOf(document, 'graphicLayer')
      .find((statement) => paramsOf(statement, 'graphicLayer').kind === 'text'
        && paramsOf(statement, 'graphicLayer').mode === 'set');
    const params = paramsOf(textSet!, 'graphicLayer');
    if (params.kind !== 'text') throw new Error('expected text layer');
    expect(params.fontSize).toBe(84);
    expect(params.color).toBe('rgba(255,255,255,1)');
    // 1 line × 2000ms + 1500ms hold approximation.
    const remove = statementsOf(document, 'graphicLayer')
      .find((statement) => paramsOf(statement, 'graphicLayer').mode === 'remove');
    expect(remove!.time).toBeCloseTo(3.5, 5);
  });

  it('lays intro backgroundImage behind the text', () => {
    const { document } = convertWebGalToSceneDocument(
      'intro:标题 -backgroundImage=bg.png;',
      { mountId: 'webgal-demo' },
    );
    const imageSet = statementsOf(document, 'graphicLayer')
      .find((statement) => paramsOf(statement, 'graphicLayer').kind === 'image'
        && paramsOf(statement, 'graphicLayer').mode === 'set');
    const params = paramsOf(imageSet!, 'graphicLayer');
    if (params.kind !== 'image') throw new Error('expected image layer');
    expect(params.id).toBe('webgal-intro-bg');
    expect(params.file).toBe('@mount/webgal-demo/background/bg.png');
  });

  it('reports intro animations and backgroundColor it cannot reproduce', () => {
    const { document, report } = convertWebGalToSceneDocument(
      'intro:文字 -animation=typingEffect -backgroundColor=rgba(0,0,0,0.8);',
    );
    expect(report.notes.some((note) => note.message.includes('typingEffect'))).toBe(true);
    expect(report.notes.some((note) => note.message.includes('backgroundColor'))).toBe(true);
    expect(statementsOf(document, 'graphicLayer').length).toBeGreaterThan(0);
  });

  it('advances the timeline for wait as an empty shot', () => {
    const { document } = convertWebGalToSceneDocument(':第一句;wait:5000;:第二句;');
    const dialogue = statementsOf(document, 'dialogue');
    expect(dialogue[1].time).toBeGreaterThanOrEqual(dialogue[0].time + 5);
  });

  it('advances the timeline for wait even with -next', () => {
    const { document } = convertWebGalToSceneDocument(':第一句;wait:2000 -next;:第二句;');
    const dialogue = statementsOf(document, 'dialogue');
    expect(dialogue[1].time).toBeGreaterThanOrEqual(dialogue[0].time + 2);
  });

  it('reports an invalid wait duration', () => {
    const { report } = convertWebGalToSceneDocument('wait:abc;');
    expect(report.notes.some((note) => note.message.includes('wait'))).toBe(true);
  });

  it('converts setTransform on bg-main into an environment transform', () => {
    const { document } = convertWebGalToSceneDocument(
      'changeBg:A.png;'
      + 'setTransform:{"position":{"x":200},"rotation":0.1} -target=bg-main -duration=600;',
    );
    const transforms = statementsOf(document, 'environmentLayer')
      .filter((statement) => paramsOf(statement, 'environmentLayer').mode === 'transform');
    expect(transforms).toHaveLength(1);
    const params = paramsOf(transforms[0], 'environmentLayer');
    expect(params.position?.[0]).toBeCloseTo(0.5 + 200 / 2560, 5);
    expect(params.position?.[1]).toBeCloseTo(0.5, 5);
    expect(params.rotation).toBe(0.1);
    expect(params.durationSeconds).toBe(0.6);
  });

  it('reports setTransform on stage-main as unsupported', () => {
    const { report } = convertWebGalToSceneDocument(
      'setTransform:{"rotation":1} -target=stage-main;',
    );
    expect(report.notes.some((note) => note.message.includes('stage-main'))).toBe(true);
  });

  it('imports a narration-only script with a Chinese speaker', () => {
    const { document, report } = convertWebGalToSceneDocument(
      ':第一句旁白;素世:你好。;',
    );
    expect(statementsOf(document, 'dialogue')).toHaveLength(2);
    expect(report.stats.narrationCount).toBe(1);
    const dialogue = statementsOf(document, 'dialogue')
      .find((statement) => paramsOf(statement, 'dialogue').speakerId !== undefined);
    expect(dialogue).toBeDefined();
    const charIds = (document.meta.characters ?? []).map((character) => character.id);
    expect(charIds).toContain(paramsOf(dialogue!, 'dialogue').speakerId);
  });

  describe('joinWebGalScriptTexts', () => {
    it('joins every script part in order, inserting the default black chapter-break marker', () => {
      const joined = joinWebGalScriptTexts({
        scriptText: 'changeBg:A.png;',
        additionalScripts: [
          { scriptText: '\uFEFFchangeBg:B.png;' },
          { scriptText: ':尾声。;' },
        ],
      });
      expect(joined).toBe(
        'changeBg:A.png;\nchapterBreak:black;\nchangeBg:B.png;\nchapterBreak:black;\n:尾声。;',
      );
    });

    it('inserts the selected chapter transition between parts', () => {
      const joined = joinWebGalScriptTexts({
        scriptText: 'changeBg:A.png;',
        additionalScripts: [{ scriptText: ':第二部。;' }],
        chapterTransition: 'fade',
      });
      expect(joined).toBe('changeBg:A.png;\nchapterBreak:fade;\n:第二部。;');
    });

    it('returns only the first script when there are no additional parts', () => {
      expect(joinWebGalScriptTexts({ scriptText: ':只有一部。;' })).toBe(':只有一部。;');
    });

    it('produces one continuous timeline with shared character state', () => {
      const joined = joinWebGalScriptTexts({
        scriptText: 'changeFigure:soyo/model.json -id=1;Soyo:第一部 -figureId=1;',
        additionalScripts: [{ scriptText: 'Soyo:第二部 -figureId=1;' }],
      });
      const { document, report } = convertWebGalToSceneDocument(joined, { mountId: 'webgal-sv' });
      expect(report.stats.dialogueCount).toBe(2);
      // The speaker of chapter 2 reuses the character from chapter 1.
      expect((document.meta.characters ?? []).filter((character) => character.id === 'soyo')).toHaveLength(1);
      const dialogueTimes = statementsOf(document, 'dialogue').map((statement) => statement.time);
      expect(dialogueTimes[1]).toBeGreaterThan(dialogueTimes[0]);
    });
  });

  describe('chapter break transitions', () => {
    const CHAPTER_SCRIPT = 'changeFigure:soyo/model.json -id=1;Soyo:第一部 -figureId=1;';

    const gapAfter = (document: CurrentSceneDocument): number => {
      const dialogue = statementsOf(document, 'dialogue');
      const firstDuration = paramsOf(dialogue[0], 'dialogue').durationSeconds;
      return dialogue[1].time - dialogue[0].time - firstDuration;
    };

    it('black: exits every on-stage character and fades the background to a held black screen', () => {
      const { document, report } = convertWebGalToSceneDocument(
        `${CHAPTER_SCRIPT}\nchapterBreak:black;\n:第二部开始。;`,
      );
      const exits = statementsOf(document, 'characterPresence')
        .filter((statement) => paramsOf(statement, 'characterPresence').mode === 'exit');
      expect(exits).toHaveLength(1);
      expect(paramsOf(exits[0], 'characterPresence').id).toBe('soyo');
      expect(report.stats.figureExits).toBe(1);

      const backgroundRemoves = statementsOf(document, 'environmentLayer')
        .filter((statement) => paramsOf(statement, 'environmentLayer').mode === 'remove');
      expect(backgroundRemoves).toHaveLength(1);

      // max(exit 0.45, fade 1.0) + black hold 2.0.
      expect(gapAfter(document)).toBeCloseTo(3.0, 5);
    });

    it('fade: exits characters and fades the background out without a hold', () => {
      const { document } = convertWebGalToSceneDocument(
        `${CHAPTER_SCRIPT}\nchapterBreak:fade;\n:第二部开始。;`,
      );
      const backgroundRemoves = statementsOf(document, 'environmentLayer')
        .filter((statement) => paramsOf(statement, 'environmentLayer').mode === 'remove');
      expect(backgroundRemoves).toHaveLength(1);
      // max(exit 0.45, fade 1.0), no hold.
      expect(gapAfter(document)).toBeCloseTo(1.0, 5);
    });

    it('none: exits characters but leaves the background untouched', () => {
      const { document } = convertWebGalToSceneDocument(
        `${CHAPTER_SCRIPT}\nchapterBreak:none;\n:第二部开始。;`,
      );
      const backgroundRemoves = statementsOf(document, 'environmentLayer')
        .filter((statement) => paramsOf(statement, 'environmentLayer').mode === 'remove');
      expect(backgroundRemoves).toHaveLength(0);
      const exits = statementsOf(document, 'characterPresence')
        .filter((statement) => paramsOf(statement, 'characterPresence').mode === 'exit');
      expect(exits).toHaveLength(1);
      // exit 0.45 only.
      expect(gapAfter(document)).toBeCloseTo(0.45, 5);
    });

    it('unknown transition content falls back to the black treatment', () => {
      const { document } = convertWebGalToSceneDocument(
        `${CHAPTER_SCRIPT}\nchapterBreak:whatever;\n:第二部开始。;`,
      );
      const backgroundRemoves = statementsOf(document, 'environmentLayer')
        .filter((statement) => paramsOf(statement, 'environmentLayer').mode === 'remove');
      expect(backgroundRemoves).toHaveLength(1);
      expect(gapAfter(document)).toBeCloseTo(3.0, 5);
    });
  });

  describe('review findings fixes', () => {
    it('handleSetComplexAnimation and handleSetTransform fall back to lastFocusedCharacterId when target is omitted', () => {
      const script = [
        'changeFigure:char_a/stand.png -id=soyo;',
        'setTransform:{"position":{"x":100,"y":0}};',
        'setComplexAnimation:universalSoftOff -duration=600;',
      ].join('\n');
      const { document } = convertWebGalToSceneDocument(script);
      const transforms = statementsOf(document, 'characterTransform');
      expect(transforms).toHaveLength(2);
      expect(paramsOf(transforms[0], 'characterTransform').id).toBe('char-a');
      expect(paramsOf(transforms[1], 'characterTransform').id).toBe('char-a');
      expect(paramsOf(transforms[1], 'characterTransform').opacity).toBe(0);
    });

    it('handleSetTempAnimation supports numeric scale and updates tracked transform', () => {
      const script = [
        'changeFigure:char_a/stand.png -id=soyo;',
        'setTempAnimation:[{"scale":1.5,"duration":500}];',
        'changeFigure:char_a/stand.png -id=soyo;',
      ].join('\n');
      const { document } = convertWebGalToSceneDocument(script);
      const transforms = statementsOf(document, 'characterTransform');
      expect(transforms.length).toBeGreaterThanOrEqual(1);
      const animTransform = paramsOf(transforms[0], 'characterTransform');
      expect(animTransform.scale).toBeCloseTo(1.5 * (1.1 / 0.8), 4);
      // Because lastTransform now tracks scale: 2.0625, the subsequent identical changeFigure
      // with same model does NOT emit an unexpected delta transform.
      expect(transforms).toHaveLength(1);
    });

    it('handleFigureExit recognizes -left and -right position flags', () => {
      const script = [
        'changeFigure:char_a/stand.png -left;',
        'changeFigure:none -left;',
        'changeFigure:char_b/stand.png -right;',
        'changeFigure:none -right;',
      ].join('\n');
      const { document, report } = convertWebGalToSceneDocument(script);
      const exits = statementsOf(document, 'characterPresence')
        .filter((statement) => paramsOf(statement, 'characterPresence').mode === 'exit');
      expect(exits).toHaveLength(2);
      expect(report.stats.figureExits).toBe(2);
    });
  });
});
