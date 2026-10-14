import type {
  CurrentSceneDocument,
  DialogueCompanion,
  SceneStatement,
} from '../../api/types/semantic-scene';
import { sceneStatementDefinitionRegistry } from '../semantic-scene/SceneStatementDefinitionRegistry';
import type { IFileAccess } from './IFileAccess';

interface MotionEvent {
  readonly time: number;
  readonly order: number;
  readonly source: SceneStatement | DialogueCompanion;
  readonly speakerId?: string;
}

/** Read one finite cycle even when the source file declares a looping motion. */
export function parseResourceMotionDuration(text: string): number {
  if (text.trimStart().startsWith('{')) {
    const json: unknown = JSON.parse(text);
    const duration = asRecord(asRecord(json)?.Meta)?.Duration;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) return duration;
    throw new Error('Motion3 Meta.Duration must be finite and positive');
  }

  // Cubism 2 .mtn stores one value per frame. Its default sample rate is 30 Hz.
  let fps = 30;
  let frames = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equal = line.indexOf('=');
    if (equal < 0) continue;
    const key = line.slice(0, equal).trim();
    const value = line.slice(equal + 1).trim();
    if (key === '$fps') {
      const declaredFps = Number(value);
      if (declaredFps > 5 && declaredFps < 121) fps = declaredFps;
    } else if (!key.startsWith('$') && key) {
      const samples = value.split(/[,\s]+/).filter(Boolean);
      if (samples.some((sample) => !Number.isFinite(Number(sample)))) {
        throw new Error('Invalid Cubism 2 motion samples');
      }
      frames = Math.max(frames, samples.length);
    }
  }
  const duration = frames / fps;
  if (fps > 0 && Number.isFinite(duration) && duration > 0) return duration;
  throw new Error('Cubism 2 motion has no finite positive duration');
}

/**
 * Materialize resource timing on a detached source before the pure compiler.
 * Caches live for one preparation only, so project, model and file changes are
 * observed on the next edit/load and failed reads can recover.
 */
export async function materializeResourceMotionDurations(
  scene: CurrentSceneDocument,
  fileAccess: IFileAccess,
  resolveModelPath: (reference: string) => Promise<string>,
): Promise<void> {
  const resolver = new ResourceMotionDurationReader(fileAccess);
  const characters = new Map((scene.meta.characters ?? []).map((character) => [character.id, character]));
  const models = new Map((scene.meta.characters ?? [])
    .filter((character) => character.model)
    .map((character) => [character.id, character.model!]));
  const events: MotionEvent[] = [];
  let order = 0;
  for (const statement of scene.statements) {
    events.push({ time: statement.time, order: order++, source: statement });
    for (const companion of statement.companions ?? []) {
      events.push({
        time: statement.time
          + (companion.anchor === 'end' ? sceneStatementDefinitionRegistry.temporalExtent(statement) : 0)
          + companion.offset,
        order: order++,
        source: companion,
        speakerId: statement.type === 'dialogue' ? statement.params.speakerId : undefined,
      });
    }
  }
  events.sort((a, b) => a.time - b.time || a.order - b.order);

  let sceneEnd = 0;
  for (const event of events) {
    const source = event.source;
    if (source.type === 'characterPresence' && source.params.mode === 'enter') {
      const character = characters.get(source.params.id);
      // Match lowerCharacterPresence: model pickers materialize the selected
      // variant path in params.model; the variant name alone is not a switch.
      const model = source.params.model ?? character?.model;
      if (model) models.set(source.params.id, model);
      else models.delete(source.params.id);
    }
    if (source.type === 'characterPerformance' && source.params.motion && source.params.motion.kind === 'resource') {
      const motion = source.params.motion;
      const target = source.params.target === '$speaker' ? event.speakerId : source.params.target;
      const model = target ? models.get(target) : undefined;
      let duration = motion.durationSeconds && motion.durationSeconds > 0 ? motion.durationSeconds : 1;
      try {
        if (!model) throw new Error('No model bound to the motion target');
        duration = await resolver.read(await resolveModelPath(model), motion.key);
      } catch (error) {
        console.warn(`[Live2D] Cannot resolve duration for ${target ?? source.params.target}/${motion.key}; reserving ${duration}s`, error);
      }
      source.params.motion = { ...motion, durationSeconds: Math.max(duration, motion.fadeInSeconds ?? 0) };
    }
    sceneEnd = Math.max(sceneEnd, event.time + sceneStatementDefinitionRegistry.temporalExtent(source as SceneStatement));
  }
  if (scene.meta.durationSeconds !== undefined) {
    scene.meta.durationSeconds = Math.max(scene.meta.durationSeconds, sceneEnd);
  }
}

class ResourceMotionDurationReader {
  private readonly files = new Map<string, Promise<string>>();
  private readonly durations = new Map<string, Promise<number>>();

  constructor(private readonly fileAccess: IFileAccess) {}

  read(modelPath: string, key: string): Promise<number> {
    const cacheKey = JSON.stringify([modelPath, key]);
    let result = this.durations.get(cacheKey);
    if (!result) {
      result = this.readModel(modelPath, key, new Set());
      this.durations.set(cacheKey, result);
    }
    return result;
  }

  private readText(path: string): Promise<string> {
    let result = this.files.get(path);
    if (!result) {
      result = this.fileAccess.readFile(path).then((file) => file.data);
      this.files.set(path, result);
    }
    return result;
  }

  private async readModel(modelPath: string, key: string, ancestors: ReadonlySet<string>): Promise<number> {
    if (ancestors.has(modelPath)) throw new Error('Cyclic Live2D composed model reference');
    if (ancestors.size >= 32) throw new Error('Live2D composed model nesting exceeds 32 levels');
    const json: unknown = JSON.parse(await this.readText(modelPath));
    const model = asRecord(json);
    if (!model) throw new Error('Invalid Live2D model JSON');
    const directory = await this.fileAccess.dirname(modelPath);
    if (typeof model.modelRelativePath === 'string') {
      const subModels = Array.isArray(model.subModels) ? model.subModels : [];
      const paths = [model.modelRelativePath, ...subModels.map((sub) => asRecord(sub)?.modelRelativePath)]
        .filter((path): path is string => typeof path === 'string' && !!path);
      const visited = new Set([...ancestors, modelPath]);
      const durations = await Promise.allSettled(paths.map(async (path) =>
        this.readModel(await this.fileAccess.join(directory, path), key, visited)));
      const resolved = durations.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      if (resolved.length) return Math.max(...resolved);
      throw new Error(`Motion ${key} not found in composed model`);
    }
    const groups = asRecord(asRecord(model.FileReferences)?.Motions) ?? asRecord(model.motions);
    const requestedKey = key.trim();
    const leaf = requestedKey.split('/').at(-1);
    const matches = Object.keys(groups ?? {}).filter((group) => group.split('/').at(-1) === leaf);
    const group = groups?.[requestedKey] ?? (matches.length === 1 ? groups?.[matches[0]] : undefined);
    const definition = Array.isArray(group) ? asRecord(group[0]) : undefined;
    const file = definition?.File ?? definition?.file;
    if (typeof file !== 'string' || !file) throw new Error(`Motion ${key} has no source file`);
    return parseResourceMotionDuration(await this.readText(await this.fileAccess.join(directory, file)));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
