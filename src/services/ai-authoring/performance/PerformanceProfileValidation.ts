import {
  PERFORMANCE_PROFILE_SCHEMA_VERSION,
  type PerformanceProfileCharacterV1,
  type PerformanceProfileDiagnostic,
  type PerformanceProfileDocumentV1,
  type PerformanceProfileKeyEntryV1,
  type PerformanceProfileManifestEntryV1,
} from './PerformanceProfileTypes';

export class PerformanceProfileValidationError extends Error {
  readonly diagnostics: readonly PerformanceProfileDiagnostic[];

  constructor(diagnostics: readonly PerformanceProfileDiagnostic[], message?: string) {
    const primary = diagnostics[0];
    super(message ?? primary?.message ?? 'Performance profile validation failed');
    this.name = 'PerformanceProfileValidationError';
    this.diagnostics = diagnostics;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectNonEmptyString(
  value: unknown,
  path: string,
  diagnostics: PerformanceProfileDiagnostic[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    diagnostics.push({
      code: 'invalid_profile',
      message: `${path} must be a non-empty string`,
      path,
    });
    return undefined;
  }
  return value;
}

function parseKeyEntries(
  value: unknown,
  path: string,
  diagnostics: PerformanceProfileDiagnostic[],
): PerformanceProfileKeyEntryV1[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push({
      code: 'invalid_profile',
      message: `${path} must be an array`,
      path,
    });
    return undefined;
  }
  const entries: PerformanceProfileKeyEntryV1[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      diagnostics.push({
        code: 'invalid_profile',
        message: `${itemPath} must be an object`,
        path: itemPath,
      });
      continue;
    }
    const key = expectNonEmptyString(item.key, `${itemPath}.key`, diagnostics);
    if (key === undefined) continue;
    if (seen.has(key)) {
      diagnostics.push({
        code: 'invalid_profile',
        message: `${itemPath}.key duplicates key "${key}"`,
        path: `${itemPath}.key`,
        key,
      });
      continue;
    }
    seen.add(key);
    const description = item.description === undefined
      ? undefined
      : expectNonEmptyString(item.description, `${itemPath}.description`, diagnostics);
    if (item.description !== undefined && description === undefined) continue;
    entries.push(description === undefined ? { key } : { key, description });
  }
  return entries;
}

function parseCharacter(
  value: unknown,
  path: string,
  diagnostics: PerformanceProfileDiagnostic[],
): PerformanceProfileCharacterV1 | undefined {
  if (!isRecord(value)) {
    diagnostics.push({
      code: 'invalid_profile',
      message: `${path} must be an object`,
      path,
    });
    return undefined;
  }
  const id = expectNonEmptyString(value.id, `${path}.id`, diagnostics);
  if (id === undefined) return undefined;

  let aliases: string[] | undefined;
  if (value.aliases !== undefined) {
    if (!Array.isArray(value.aliases)) {
      diagnostics.push({
        code: 'invalid_profile',
        message: `${path}.aliases must be an array`,
        path: `${path}.aliases`,
      });
      return undefined;
    }
    aliases = [];
    for (let index = 0; index < value.aliases.length; index += 1) {
      const alias = expectNonEmptyString(
        value.aliases[index],
        `${path}.aliases[${index}]`,
        diagnostics,
      );
      if (alias !== undefined) aliases.push(alias);
    }
  }

  // Legacy v1 names become explicit aliases at the decoding boundary.
  // Normalized documents and future saves contain only ids and aliases.
  if (value.canonicalName !== undefined) {
    const legacyName = expectNonEmptyString(value.canonicalName, `${path}.canonicalName`, diagnostics);
    if (legacyName !== undefined) aliases = [...new Set([legacyName, ...(aliases ?? [])])];
  }

  const motions = parseKeyEntries(value.motions, `${path}.motions`, diagnostics);
  const expressions = parseKeyEntries(value.expressions, `${path}.expressions`, diagnostics);
  if (motions === undefined || expressions === undefined) return undefined;

  return {
    id,
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    ...(motions.length > 0 ? { motions } : {}),
    ...(expressions.length > 0 ? { expressions } : {}),
  };
}

/**
 * Validate and normalize a versioned performance profile document.
 * Corrupt or unsupported schema versions throw — callers must not treat them as "no provider".
 */
export function parsePerformanceProfileDocument(input: unknown): PerformanceProfileDocumentV1 {
  const diagnostics: PerformanceProfileDiagnostic[] = [];
  if (!isRecord(input)) {
    throw new PerformanceProfileValidationError([{
      code: 'invalid_profile',
      message: 'Performance profile must be an object',
    }]);
  }

  if (input.schemaVersion !== PERFORMANCE_PROFILE_SCHEMA_VERSION) {
    throw new PerformanceProfileValidationError([{
      code: 'unsupported_schema_version',
      message: `Unsupported performance profile schemaVersion: expected ${PERFORMANCE_PROFILE_SCHEMA_VERSION}`,
      path: 'schemaVersion',
      profileId: typeof input.id === 'string' ? input.id : undefined,
    }]);
  }

  const id = expectNonEmptyString(input.id, 'id', diagnostics);
  const name = expectNonEmptyString(input.name, 'name', diagnostics);
  if (!Array.isArray(input.characters)) {
    diagnostics.push({
      code: 'invalid_profile',
      message: 'characters must be an array',
      path: 'characters',
    });
  }

  const characters: PerformanceProfileCharacterV1[] = [];
  const characterIds = new Set<string>();
  if (Array.isArray(input.characters)) {
    for (let index = 0; index < input.characters.length; index += 1) {
      const character = parseCharacter(input.characters[index], `characters[${index}]`, diagnostics);
      if (!character) continue;
      if (characterIds.has(character.id)) {
        diagnostics.push({
          code: 'invalid_profile',
          message: `Duplicate character id "${character.id}"`,
          path: `characters[${index}].id`,
          characterId: character.id,
        });
        continue;
      }
      characterIds.add(character.id);
      characters.push(character);
    }
  }

  if (diagnostics.length > 0 || id === undefined || name === undefined) {
    throw new PerformanceProfileValidationError(diagnostics, 'Performance profile document is invalid');
  }

  return {
    schemaVersion: PERFORMANCE_PROFILE_SCHEMA_VERSION,
    id,
    name,
    characters,
  };
}

/**
 * Validate a template manifest performanceProfiles entry.
 * Inline characters and file are mutually exclusive.
 */
export function parsePerformanceProfileManifestEntry(
  input: unknown,
): PerformanceProfileManifestEntryV1 {
  const diagnostics: PerformanceProfileDiagnostic[] = [];
  if (!isRecord(input)) {
    throw new PerformanceProfileValidationError([{
      code: 'invalid_profile',
      message: 'Performance profile manifest entry must be an object',
    }]);
  }

  if (input.schemaVersion !== PERFORMANCE_PROFILE_SCHEMA_VERSION) {
    throw new PerformanceProfileValidationError([{
      code: 'unsupported_schema_version',
      message: `Unsupported performance profile schemaVersion: expected ${PERFORMANCE_PROFILE_SCHEMA_VERSION}`,
      path: 'schemaVersion',
      profileId: typeof input.id === 'string' ? input.id : undefined,
    }]);
  }

  const id = expectNonEmptyString(input.id, 'id', diagnostics);
  const name = expectNonEmptyString(input.name, 'name', diagnostics);
  const hasCharacters = input.characters !== undefined;
  const hasFile = input.file !== undefined;

  if (hasCharacters && hasFile) {
    diagnostics.push({
      code: 'invalid_profile',
      message: 'Performance profile manifest entry cannot provide both characters and file',
      path: 'characters',
      profileId: id,
    });
  }
  if (!hasCharacters && !hasFile) {
    diagnostics.push({
      code: 'invalid_profile',
      message: 'Performance profile manifest entry must provide characters or file',
      path: 'characters',
      profileId: id,
    });
  }

  let characters: PerformanceProfileCharacterV1[] | undefined;
  if (hasCharacters) {
    if (!Array.isArray(input.characters)) {
      diagnostics.push({
        code: 'invalid_profile',
        message: 'characters must be an array',
        path: 'characters',
      });
    } else {
      characters = [];
      const characterIds = new Set<string>();
      for (let index = 0; index < input.characters.length; index += 1) {
        const character = parseCharacter(input.characters[index], `characters[${index}]`, diagnostics);
        if (!character) continue;
        if (characterIds.has(character.id)) {
          diagnostics.push({
            code: 'invalid_profile',
            message: `Duplicate character id "${character.id}"`,
            path: `characters[${index}].id`,
            characterId: character.id,
          });
          continue;
        }
        characterIds.add(character.id);
        characters.push(character);
      }
    }
  }

  let file: string | undefined;
  if (hasFile) {
    file = expectNonEmptyString(input.file, 'file', diagnostics);
  }

  if (diagnostics.length > 0 || id === undefined || name === undefined) {
    throw new PerformanceProfileValidationError(diagnostics);
  }

  return {
    schemaVersion: PERFORMANCE_PROFILE_SCHEMA_VERSION,
    id,
    name,
    ...(characters ? { characters } : {}),
    ...(file ? { file } : {}),
  };
}

/** Build a full profile document from an inline manifest entry. */
export function materializeInlinePerformanceProfile(
  entry: PerformanceProfileManifestEntryV1,
): PerformanceProfileDocumentV1 {
  if (!entry.characters) {
    throw new PerformanceProfileValidationError([{
      code: 'invalid_profile',
      message: 'Cannot materialize inline profile without characters',
      profileId: entry.id,
    }]);
  }
  return parsePerformanceProfileDocument({
    schemaVersion: entry.schemaVersion,
    id: entry.id,
    name: entry.name,
    characters: entry.characters,
  });
}
