import type {
  WebGalParseResult,
  WebGalFlagValue,
  WebGalSentence,
} from './WebGalImportTypes';

/**
 * Commands AeonStagery's importer recognizes as WebGAL instructions
 * (stored lowercase; matching is case-insensitive). Anything else before the
 * first ':' is treated as a speaker name. Recognized-but-unconverted commands
 * are recorded in the import report instead of being mis-parsed as dialogue.
 *
 * The list covers both the modern WebGAL documentation set and the legacy
 * command names some scripts still use, so visual/audio/flow commands are never
 * mistaken for a speaker. Game-only commands (choices, variables, jumps, scene
 * switching, galleries, ...) stay recognized-but-ignored: importing a WebGAL
 * script produces a linear video-ready scene, never gameplay.
 */
const KNOWN_COMMANDS = new Set<string>([
  // Converted by the scene converter.
  'changebg',
  'changefigure',
  'settransform',
  'bgm',
  'playeffect',
  'intro',
  'wait',
  'settempanimation',
  'setcomplexanimation',
  'settransition',
  // Synthetic boundary marker injected between merged scripts (never typed
  // by hand); its content selects the chapter-break background treatment.
  'chapterbreak',
  // Legacy audio commands routed into the same audio statements.
  'playbgm',
  'stopbgm',
  'stopeffect',
  'playvoice',
  'stopvoice',
  // Recognized but not converted (recorded in the import report).
  'changescene',
  'callscene',
  'setfigure',
  'playvideo',
  'showtextbox',
  'hidetextbox',
  'settextbox',
  'changename',
  'setname',
  'settext',
  'setanimation',
  'setvariant',
  'setfontsize',
  'setspeed',
  'setvolume',
  'setcharacterstate',
  'setbgstate',
  'setfilter',
  'setpreset',
  'jumplabel',
  'label',
  'setvar',
  'setvar2',
  'if',
  'else',
  'endif',
  'choose',
  'choosearray',
  'return',
  'clearalltext',
  'cleartext',
  'openurl',
  'evaluatescript',
  'end',
  'getuserinput',
  'applystyle',
  'filmmode',
  'miniavatar',
  'showvars',
  'unlockcg',
  'unlockbgm',
  'callsteam',
  'pixiinit',
  'pixiperform',
  'comment',
  // Legacy visual-effect commands from older WebGAL versions.
  'changefilter',
  'setbg',
  'flash',
  'shake',
  'light',
  'camera',
  'playvocal',
  'stopvideo',
]);

/**
 * Commands that may appear without content and without a colon, following the
 * legacy WebGAL style (`stopBgm;`, `end;`, `pixiInit;`).
 */
const NO_CONTENT_COMMANDS = new Set<string>([
  'stopbgm',
  'stopeffect',
  'stopvoice',
  'end',
  'return',
  'pixiinit',
  'clearalltext',
  'cleartext',
  'showvars',
  'comment',
  'else',
  'endif',
]);

const COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;

export function parseWebGalScript(raw: string): WebGalParseResult {
  const cleaned = stripComments(raw);
  const cleanedLines: Array<{ text: string; lineNumber: number }> = cleaned
    .split('\n')
    .map((text, index) => ({ text, lineNumber: index + 1 }));
  const fullText = cleanedLines.map((line) => line.text).join('\n');

  const lineOffsets = buildLineOffsets(fullText);
  const sentences: WebGalSentence[] = [];

  let cursor = 0;
  while (cursor < fullText.length) {
    const endIndex = fullText.indexOf(';', cursor);
    const rawSentence = endIndex === -1 ? fullText.slice(cursor) : fullText.slice(cursor, endIndex);
    const contentOffset = cursor + firstNonWhitespaceIndex(rawSentence);
    const lineNumber = lineNumberAt(lineOffsets, contentOffset);
    cursor = endIndex === -1 ? fullText.length : endIndex + 1;

    const sentence = parseSentence(rawSentence, lineNumber);
    if (sentence) sentences.push(sentence);
  }

  return { sentences };
}

function firstNonWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (!/\s/.test(value[index])) return index;
  }
  return 0;
}

/**
 * Removes WebGAL comments while preserving line numbers as closely as possible:
 * - block comments are replaced with the newlines they contained;
 * - full-line `//` and `##` lines are blanked;
 * - inline `//` comments after a sentence separator are stripped.
 */
function stripComments(raw: string): string {
  const normalized = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const withoutBlocks = normalized.replace(COMMENT_REGEX, (match) =>
    match.replace(/[^\n]/g, ''),
  );

  return withoutBlocks
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('##')) return '';
      const boundary = line.match(/(^|;)\s*\/\//);
      if (!boundary) return line;
      return line.slice(0, (boundary.index ?? 0) + boundary[1].length);
    })
    .join('\n');
}

function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function lineNumberAt(lineOffsets: number[], offset: number): number {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineOffsets[mid] > offset) {
      high = mid - 1;
    } else {
      low = mid;
    }
  }
  return low + 1;
}

function parseSentence(raw: string, lineNumber: number): WebGalSentence | null {
  const { body, flags } = splitFlags(raw);

  const colonIndex = body.indexOf(':');
  if (colonIndex === -1) {
    const text = body.trim();
    // Legacy WebGAL stop-commands (`stopBgm;`, `stopEffect;`) and flow
    // commands (`end;`, `return;`) carry no content and no colon.
    if (NO_CONTENT_COMMANDS.has(text.toLowerCase())) {
      return { kind: 'command', lineNumber, command: text.toLowerCase(), content: '', flags, raw };
    }
    return text
      ? { kind: 'narration', lineNumber, text, flags, raw }
      : null;
  }

  const prefix = body.slice(0, colonIndex).trim();
  const content = body.slice(colonIndex + 1).trim();

  if (prefix === '') {
    return content
      ? { kind: 'narration', lineNumber, text: content, flags, raw }
      : null;
  }

  if (KNOWN_COMMANDS.has(prefix.toLowerCase())) {
    return { kind: 'command', lineNumber, command: prefix.toLowerCase(), content, flags, raw };
  }

  return content
    ? { kind: 'dialogue', lineNumber, speaker: prefix, text: content, flags, raw }
    : null;
}

function splitFlags(raw: string): {
  body: string;
  flags: Record<string, WebGalFlagValue>;
} {
  const flagIndices: number[] = [];
  let inQuotes: string | null = null;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (inQuotes) {
      if (char === '\\') {
        i += 1;
      } else if (char === inQuotes) {
        inQuotes = null;
      }
    } else if (char === '"' || char === "'") {
      inQuotes = char;
    } else if (char === '{') {
      braceDepth += 1;
    } else if (char === '}') {
      if (braceDepth > 0) braceDepth -= 1;
    } else if (char === '[') {
      bracketDepth += 1;
    } else if (char === ']') {
      if (bracketDepth > 0) bracketDepth -= 1;
    } else if (braceDepth === 0 && bracketDepth === 0) {
      if (/\s/.test(char)) {
        let nextIndex = i + 1;
        while (nextIndex < raw.length && /\s/.test(raw[nextIndex])) {
          nextIndex += 1;
        }
        if (raw[nextIndex] === '-' && nextIndex + 1 < raw.length && /[a-zA-Z0-9_./\\]/.test(raw[nextIndex + 1])) {
          flagIndices.push(i);
          i = nextIndex;
        }
      }
    }
  }

  if (flagIndices.length === 0) return { body: raw, flags: {} };

  const body = raw.slice(0, flagIndices[0]);
  const flags: Record<string, WebGalFlagValue> = {};
  for (let idx = 0; idx < flagIndices.length; idx += 1) {
    const start = flagIndices[idx];
    const end = idx + 1 < flagIndices.length ? flagIndices[idx + 1] : raw.length;
    const token = raw.slice(start, end).trim();
    const cleanToken = token.replace(/^-+/, '');
    if (!cleanToken) continue;
    const equalsIndex = cleanToken.indexOf('=');
    if (equalsIndex === -1) {
      flags[cleanToken] = undefined;
    } else {
      flags[cleanToken.slice(0, equalsIndex)] = cleanToken.slice(equalsIndex + 1);
    }
  }
  return { body, flags };
}
