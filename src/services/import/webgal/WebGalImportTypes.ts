import type { CurrentSceneDocument } from '../../../api/types/semantic-scene';

export type WebGalFlagValue = string | undefined;

export type WebGalSentence =
  | {
    kind: 'narration';
    lineNumber: number;
    text: string;
    flags: Record<string, WebGalFlagValue>;
    raw: string;
  }
  | {
    kind: 'dialogue';
    lineNumber: number;
    speaker: string;
    text: string;
    flags: Record<string, WebGalFlagValue>;
    raw: string;
  }
  | {
    kind: 'command';
    lineNumber: number;
    command: string;
    content: string;
    flags: Record<string, WebGalFlagValue>;
    raw: string;
  };

export interface WebGalParseResult {
  sentences: WebGalSentence[];
}

export interface WebGalDurationOptions {
  /** Estimated seconds spent per character of text. */
  perCharSeconds?: number;
  /** Fixed base seconds added to every line. */
  baseSeconds?: number;
  /** Minimum estimated duration for a single line. */
  minSeconds?: number;
  /** Maximum estimated duration for a single line. */
  maxSeconds?: number;
  /** Reading pace multiplier; >1 reads faster (shorter estimated durations). */
  speed?: number;
}

export interface WebGalImportOptions {
  /** External library mount id that roots the WebGAL asset directory (contains figure/, background/, ...). */
  mountId?: string;
  /** Title of the produced scene document. */
  sceneTitle?: string;
  /** Dialogue duration estimation options. */
  duration?: WebGalDurationOptions;
}

/** One WebGAL script part carried through the project-creation flow. */
export interface WebGalImportScriptPart {
  /** The raw WebGAL script text to convert. */
  scriptText: string;
  /** Original script file name, kept on the import receipt for display. */
  scriptName?: string;
}

/**
 * How a chapter boundary between two merged scripts treats the background:
 * - `black`: fade the background out into a held black screen;
 * - `fade`: fade the background out and let the next chapter fade its own in;
 * - `none`: leave the background untouched (seamless continuity).
 * Every boundary always exits all on-stage characters first (fixed behavior).
 */
export type WebGalChapterTransition = 'none' | 'fade' | 'black';

/** Payload carried through the project-creation flow. */
export interface WebGalImportInput extends WebGalImportScriptPart {
  /**
   * Additional scripts (chapters) converted right after `scriptText`. All
   * parts are merged into ONE continuous scene timeline, so playback runs
   * through them in order without any interruption.
   */
  additionalScripts?: WebGalImportScriptPart[];
  /** Background treatment applied at the boundary between merged scripts. */
  chapterTransition?: WebGalChapterTransition;
  /** External library mount id whose root contains figure/, background/, ... */
  mountId?: string;
  /** Reading pace multiplier passed into the duration estimation (>1 = faster). */
  speed?: number;
}

export interface WebGalImportStats {
  narrationCount: number;
  dialogueCount: number;
  multiSpeakerCount: number;
  backgroundChanges: number;
  figureEnters: number;
  figureExits: number;
  transforms: number;
  performances: number;
  cameraFocuses: number;
  bgmCount: number;
  sfxCount: number;
}

export interface WebGalImportNote {
  lineNumber: number;
  message: string;
}

export interface WebGalUnsupportedCommand {
  command: string;
  lineNumber: number;
  raw: string;
}

export interface WebGalImportedCharacter {
  id: string;
  name: string;
  model?: string;
}

export interface WebGalImportReport {
  stats: WebGalImportStats;
  characters: WebGalImportedCharacter[];
  notes: WebGalImportNote[];
  unsupportedCommands: WebGalUnsupportedCommand[];
}

export interface WebGalImportResult {
  document: CurrentSceneDocument;
  report: WebGalImportReport;
}
