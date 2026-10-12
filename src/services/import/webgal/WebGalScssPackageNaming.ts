/**
 * Naming and duplicate detection for imports of WebGAL dialogue templates.
 *
 * Kept apart from {@link buildWebGalTextboxTemplatePackage} because both sides
 * of the IPC boundary need it: the main process decides what a package would be
 * called and whether it duplicates an installed one, and the dialog applies the
 * user's final choice. Sharing the functions keeps the two answers identical.
 */
import { stripComments } from './WebGalScssSyntax';
import type { WebGalScssImportConflict } from '../../../api/types/template-package-import';

export type { WebGalScssImportConflict };

/** Prefix every imported WebGAL template package id carries. */
export const WEBGAL_PACKAGE_ID_PREFIX = 'webgal-scss.';

/** Longest package name we generate, in characters. */
const MAX_NAME_LENGTH = 48;

/**
 * Turn a template name into a package directory name.
 *
 * Characters that are illegal in a Windows path (or that make a name
 * unportable) collapse into `-`; spaces do too, so the directory stays easy to
 * read on the command line. Non-ASCII is preserved, because the names users
 * care about are usually Chinese.
 */
export function slugifyWebGalPackageName(name: string): string {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    // Leading/trailing dots would let the name escape its directory.
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || 'webgal-template';
}

/**
 * Append `-2`, `-3`, … until the name is unused.
 *
 * Numbering beats a random suffix: a user who imports three variants of one
 * theme can still tell them apart in the style list.
 */
export function uniquePackageName(base: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const value of taken) used.add(String(value));
  const root = String(base ?? '').trim() || 'webgal-template';
  if (!used.has(root)) return root;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${root}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${root}-${Date.now().toString(36).slice(-4)}`;
}

/**
 * Normalise a stylesheet so cosmetic edits do not look like a new template.
 *
 * Comments and whitespace carry no meaning in the conversion, so re-indenting a
 * stylesheet or annotating it must not defeat the duplicate check. Punctuation
 * spacing is collapsed too, which is what `{ color:red }` vs `{color: red}`
 * differs by.
 *
 * {@link stripComments} removes both block and trailing line comments while
 * leaving string literals and `url(…)` alone, so annotating a declaration — on
 * its own line or at the end of one — still counts as the same template.
 */
export function normalizeScssForHashing(scss: string): string {
  return stripComments(String(scss ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*([{}:;,>~+])\s*/g, '$1');
}

/**
 * djb2 as a short base-36 string.
 *
 * Not a security primitive — it exists so two ordinary edits produce different
 * fingerprints, without pulling a hash implementation into the renderer bundle.
 */
export function hashImportSource(text: string): string {
  let hash = 5381;
  const input = String(text ?? '');
  for (let index = 0; index < input.length; index += 1) {
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

/** Fingerprint of a raw stylesheet, used to recognise an identical re-import. */
export function scssContentHash(scss: string): string {
  return hashImportSource(normalizeScssForHashing(scss));
}

/**
 * JSON with sorted keys, so key order cannot change a signature.
 *
 * `JSON.stringify` preserves insertion order, which differs between a stylesheet
 * that declares `x` before `y` and one that does the reverse even though both
 * describe the same style.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/**
 * Fingerprint of the translated parameters.
 *
 * Falls back to comparing what a template *renders as*, which still recognises
 * an older import that predates the recorded source hash.
 */
export function dialogueParamsSignature(params: unknown): string {
  return hashImportSource(stableStringify(params));
}

/** A recorded import, as written to `webgal-import.json` next to the manifest. */
export interface WebGalImportRecord {
  /** Absolute path of the WebGAL template the package came from. */
  sourcePath?: string;
  /** File name the stylesheet was read from. */
  sourceName?: string;
  /** {@link scssContentHash} of the imported stylesheet. */
  sourceHash?: string;
  /** {@link dialogueParamsSignature} of the resulting parameters. */
  paramsSignature?: string;
  /** ISO timestamp of the import. */
  importedAt?: string;
  /** Dialogue style ids this package contributed. */
  styleIds?: string[];
}

/** Name of the sidecar file recording where a package came from. */
export const WEBGAL_IMPORT_RECORD_FILE = 'webgal-import.json';

/** How a candidate import relates to an installed package. */
export type WebGalImportConflictKind = 'content' | 'params';

export interface WebGalImportConflict {
  /** Package id already installed. */
  packageId: string;
  packageName: string;
  /** The stylesheet is byte-identical after normalisation. */
  contentMatch: boolean;
  /** The translated parameters are identical (covers imports without a record). */
  paramsMatch: boolean;
  /**
   * Whether a wholesale replace is safe. An import reproduces a single dialogue
   * style, so a package publishing several cannot be overwritten — the other
   * styles and their assets would not survive it.
   */
  replaceable?: boolean;
  importedAt?: string;
  /** Absolute path the existing package was imported from, when recorded. */
  sourcePath?: string;
}

/**
 * Compare a candidate import against records of installed packages.
 *
 * Two independent signals, because neither is sufficient on its own:
 * `sourceHash` is exact but only exists for packages imported since this record
 * was introduced, while `paramsSignature` is coarser but also covers older
 * packages and templates that were edited cosmetically.
 *
 * A match says "this is the same template", not "this package may be replaced" —
 * callers decide the latter from {@link WebGalImportConflict.replaceable}.
 */
export function findWebGalImportConflicts(
  candidate: { sourceHash: string; paramsSignature: string },
  records: ReadonlyArray<{
    packageId: string;
    packageName: string;
    record: WebGalImportRecord | null;
    replaceable?: boolean;
  }>,
): WebGalScssImportConflict[] {
  const conflicts: WebGalScssImportConflict[] = [];
  for (const entry of records) {
    const record = entry.record;
    const contentMatch = !!record?.sourceHash && record.sourceHash === candidate.sourceHash;
    const paramsMatch = !!record?.paramsSignature && record.paramsSignature === candidate.paramsSignature;
    if (!contentMatch && !paramsMatch) continue;
    conflicts.push({
      packageId: entry.packageId,
      packageName: entry.packageName,
      contentMatch,
      paramsMatch,
      // Absent means the caller does not model replaceability, so keep the
      // historical behaviour rather than silently disabling replace.
      replaceable: entry.replaceable ?? true,
      ...(record?.importedAt ? { importedAt: record.importedAt } : {}),
      ...(record?.sourcePath ? { sourcePath: record.sourcePath } : {}),
    });
  }
  return conflicts;
}
