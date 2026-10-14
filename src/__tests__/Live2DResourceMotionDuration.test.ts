import { posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { IFileAccess } from '../services/io/IFileAccess';
import { materializeResourceMotionDurations, parseResourceMotionDuration } from '../services/io/Live2DResourceMotionDuration';
import { SemanticScenePipeline, sceneDocumentCodec } from '../services/semantic-scene';
import { buildSemanticTimelineReadModel } from '../ui/timeline/semanticTimelineReadModel';
import { getTimelineActionDuration } from '../ui/timeline/timelineDensity';

function fixture() {
  const files = new Map<string, string>([
    ['/project/figure/alice.model3.json', JSON.stringify({ FileReferences: { Motions: { wave: [{ File: 'wave.motion3.json' }] } } })],
    ['/project/figure/wave.motion3.json', JSON.stringify({ Meta: { Duration: 2.5, Loop: true } })],
  ]);
  const read = vi.fn(async (path: string) => {
    const data = files.get(path);
    if (data === undefined) throw new Error(`Missing fixture: ${path}`);
    return { path, data };
  });
  const fileAccess: IFileAccess = {
    readFile: read, readAsset: read,
    showOpenDialog: async () => null, showSaveDialog: async () => null,
    writeFile: async () => {}, ensureDir: async () => {}, copyFile: async () => {},
    readDir: async () => [], exists: async (path) => files.has(path),
    join: async (...parts) => posix.join(...parts),
    dirname: async (path) => posix.dirname(path), basename: async (path) => posix.basename(path),
    extname: async (path) => posix.extname(path),
  };
  const pipeline = new SemanticScenePipeline({
    resolveAsset: (source) => source,
    prepareSource: async (source) => {
      const next = structuredClone(source);
      await materializeResourceMotionDurations(next, fileAccess, async (path) => posix.join('/project', path));
      return next;
    },
  });
  const document: CurrentSceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'motion-duration',
    meta: { title: 'Motion duration', characters: [{ id: 'alice', name: 'Alice', model: 'figure/alice.model3.json' }] },
    statements: [{
      id: 'wave', time: 6, type: 'characterPerformance',
      params: { target: 'alice', motion: { kind: 'resource', key: 'wave' } },
    }],
  };
  return { document, pipeline, files, read };
}

afterEach(() => vi.restoreAllMocks());

describe('Live2D resource motion extent', () => {
  it('shares actual duration with scene end, export, timeline geometry and saved source without mutating input', async () => {
    const { pipeline, document } = fixture();
    const original = structuredClone(document);
    const bundle = await pipeline.processDocument(document);
    const item = buildSemanticTimelineReadModel(bundle.source, bundle.compiled)[0];
    expect(bundle.compiled.durationSeconds).toBe(8.5);
    expect(bundle.prepared.durationSeconds).toBe(8.5);
    expect(item.durationSeconds).toBe(2.5);
    expect(getTimelineActionDuration(item.displayAction)).toBe(2.5);
    expect(sceneDocumentCodec.prepareForSave(bundle.source)).toEqual(bundle.source);
    expect(document).toEqual(original);
  });

  it('resolves $speaker end companions, offsets and a longer authored fade', async () => {
    const { pipeline, document } = fixture();
    document.meta.durationSeconds = 6;
    document.statements = [{
      id: 'line', type: 'dialogue', time: 3,
      params: { speakerId: 'alice', text: 'Goodbye', durationSeconds: 2 },
      companions: [{
        id: 'wave', type: 'characterPerformance', anchor: 'end', offset: 1,
        params: { target: '$speaker', motion: { kind: 'resource', key: 'wave', fadeInSeconds: 4 } },
      }],
    }];
    const bundle = await pipeline.processDocument(document);
    expect(bundle.source.meta.durationSeconds).toBe(10);
    expect(bundle.prepared.durationSeconds).toBe(10);
    expect(bundle.compiled.actions.find((action) => action.action === 'playMotion')).toMatchObject({ time: 6, params: { id: 'alice' } });
  });

  it('retains explicit trailing space and shares file reads across repeated motions', async () => {
    const { pipeline, document, read } = fixture();
    document.meta.durationSeconds = 12;
    document.statements.push({ ...document.statements[0], id: 'again', time: 8 });
    const bundle = await pipeline.processDocument(document);
    expect(bundle.prepared.durationSeconds).toBe(12);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('resolves the model active at the motion time and unique motion key suffixes', async () => {
    const { pipeline, document, files } = fixture();
    files.set('/project/figure/other.model3.json', JSON.stringify({ FileReferences: { Motions: { 'alice/wave': [{ File: 'other.motion3.json' }] } } }));
    files.set('/project/figure/other.motion3.json', JSON.stringify({ Meta: { Duration: 4 } }));
    document.statements.unshift({ id: 'enter', time: 2, type: 'characterPresence', params: { mode: 'enter', id: 'alice', model: 'figure/other.model3.json' } });
    const bundle = await pipeline.processDocument(document);
    expect(bundle.prepared.durationSeconds).toBe(10);
  });

  it.each([undefined, 'figure/alice.model3.json'])('uses the compiled entrance model (%s) even when a different variant name is present', async (model) => {
    const { pipeline, document, files } = fixture();
    document.meta.characters![0].variants = [{ name: 'other', model: 'figure/other.model3.json' }];
    files.set('/project/figure/other.model3.json', JSON.stringify({ FileReferences: { Motions: { wave: [{ File: 'other.motion3.json' }] } } }));
    files.set('/project/figure/other.motion3.json', JSON.stringify({ Meta: { Duration: 1 } }));
    document.statements.unshift({
      id: 'enter', time: 2, type: 'characterPresence',
      params: { mode: 'enter', id: 'alice', model, variant: 'other' },
    });
    const bundle = await pipeline.processDocument(document);
    expect(bundle.compiled.actions.find((action) => action.action === 'addCharacter')?.params.model).toBe('figure/alice.model3.json');
    expect(bundle.prepared.durationSeconds).toBe(8.5);
  });

  it('uses the longest resolved constituent of a composed model', async () => {
    const { pipeline, document, files } = fixture();
    document.meta.characters![0].model = 'figure/composite.wmdl';
    files.set('/project/figure/composite.wmdl', JSON.stringify({ modelRelativePath: 'alice.model3.json', subModels: [{ modelRelativePath: 'sub/model.json' }] }));
    files.set('/project/figure/sub/model.json', JSON.stringify({ motions: { wave: [{ file: '../wave.mtn' }] } }));
    files.set('/project/figure/wave.mtn', `$fps=30\nPARAM_ANGLE_X=${Array.from({ length: 120 }, () => '0').join(',')}`);
    const bundle = await pipeline.processDocument(document);
    expect(bundle.prepared.durationSeconds).toBe(10);
  });

  it('preserves known duration while resources are unavailable and recovers on the next preparation', async () => {
    const { pipeline, document, files } = fixture();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.statements = [{ id: 'wave', time: 6, type: 'characterPerformance', params: { target: 'alice', motion: { kind: 'resource', key: 'wave', durationSeconds: 3 } } }];
    files.delete('/project/figure/wave.motion3.json');
    const unavailable = await pipeline.processDocument(document);
    expect(unavailable.prepared.durationSeconds).toBe(9);
    files.set('/project/figure/wave.motion3.json', JSON.stringify({ Meta: { Duration: 5 } }));
    const recovered = await pipeline.processDocument(unavailable.source);
    expect(recovered.prepared.durationSeconds).toBe(11);
  });

  it('reserves a finite fallback and reports the unresolved resource instead of ending at its start', async () => {
    const { pipeline, document, files } = fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    files.delete('/project/figure/wave.motion3.json');
    const bundle = await pipeline.processDocument(document);
    expect(bundle.prepared.durationSeconds).toBe(7);
    expect(warning).toHaveBeenCalledOnce();
  });

  it('does not extend expression-only or empty performance placeholders', async () => {
    const { pipeline, document, read } = fixture();
    document.statements = [
      { id: 'expression', time: 6, type: 'characterPerformance', params: { target: 'alice', expression: 'smile' } },
      { id: 'placeholder', time: 6, type: 'characterPerformance', params: { target: 'alice', motion: '' } },
    ];
    expect((await pipeline.processDocument(document)).prepared.durationSeconds).toBe(6);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('resource motion duration parsing', () => {
  it('reads one Motion3 cycle independently of its loop flag', () => {
    expect(parseResourceMotionDuration('{"Meta":{"Duration":2.5,"Loop":true}}')).toBe(2.5);
  });

  it('counts the longest Cubism 2 parameter or visibility curve using source fps', () => {
    expect(parseResourceMotionDuration(`# motion\r\n$fps=60\r\n$fadein=1000\r\nPARAM_X=0,1\r\nVISIBLE:body=${Array.from({ length: 180 }, () => '1').join(',')}\r\n`)).toBe(3);
  });

  it('uses Cubism 2 default fps when absent or outside SDK limits', () => {
    const curve = `PARAM_X=${Array.from({ length: 60 }, () => '0').join(',')}`;
    expect(parseResourceMotionDuration(curve)).toBe(2);
    expect(parseResourceMotionDuration(`$fps=0\n${curve}`)).toBe(2);
  });

  it('accepts Cubism 2 sample whitespace and trailing separators as the SDK does', () => {
    expect(parseResourceMotionDuration('$fps=30\nPARAM_X=0, 1,\t2 3,')).toBeCloseTo(4 / 30);
  });

  it.each(['{}', '{"Meta":{"Duration":-1}}', '# no curves', '$fps=30\nPARAM_X=0,nope'])('rejects invalid duration metadata: %s', (text) => {
    expect(() => parseResourceMotionDuration(text)).toThrow();
  });
});
