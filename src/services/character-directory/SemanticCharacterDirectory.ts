import type {
  CharacterDirectoryCommand,
  CharacterDirectoryOrigin,
} from '../../api/types/character-directory';
import type {
  CameraParams,
  CharacterPerformanceParams,
  CharacterPresenceParams,
  CharacterTransformParams,
  CustomAnimationParams,
  DialogueCompanion,
  DialogueParams,
  CurrentSceneDocument,
  CurrentSceneMeta,
  SceneStatement,
} from '../../api/types/semantic-scene';
import {
  sceneDocumentCodec,
} from '../semantic-scene';

type SceneCharacter = NonNullable<CurrentSceneMeta['characters']>[number];
type SceneCharacterVariant = NonNullable<SceneCharacter['variants']>[number];

export interface SemanticCompanionLocator {
  statementId: string;
  companionId: string;
}

export interface SemanticCharacterDirectoryReceipt {
  kind: CharacterDirectoryCommand['kind'];
  origin: CharacterDirectoryOrigin;
  affectedCharacterIds: string[];
  affectedStatementIds: string[];
  affectedCompanionLocators: SemanticCompanionLocator[];
}

export interface SemanticCharacterDirectoryResult {
  document: CurrentSceneDocument;
  receipt: SemanticCharacterDirectoryReceipt;
}

export function applyCharacterDirectoryCommandToCurrentSceneDocument(
  document: CurrentSceneDocument,
  command: CharacterDirectoryCommand,
): SemanticCharacterDirectoryResult {
  const next = cloneJson(document);
  const characters = cloneCharacters(next);
  const affectedCharacterIds = applyCharacterCommandToCharacters(command, characters);
  next.meta = {
    ...next.meta,
    characters,
  };

  const affectedStatementIds = new Set<string>();
  const affectedCompanionLocators: SemanticCompanionLocator[] = [];
  rewriteSceneDocumentCharacterReferences(
    next,
    command,
    affectedStatementIds,
    affectedCompanionLocators,
  );

  return {
    document: sceneDocumentCodec.parseAndValidate(next),
    receipt: {
      kind: command.kind,
      origin: command.origin,
      affectedCharacterIds,
      affectedStatementIds: [...affectedStatementIds],
      affectedCompanionLocators,
    },
  };
}

function cloneCharacters(document: CurrentSceneDocument): SceneCharacter[] {
  return cloneJson(document.meta.characters ?? []);
}

function applyCharacterCommandToCharacters(
  command: CharacterDirectoryCommand,
  characters: SceneCharacter[],
): string[] {
  switch (command.kind) {
    case 'add-character': {
      const charId = nextCharacterId(characters);
      characters.push({ id: charId, name: '新角色' });
      return [charId];
    }
    case 'update-character-id': {
      const target = requireCharacter(characters, command.currentCharId);
      if (command.nextCharId.trim() === '') {
        throw new Error('Character id must not be empty');
      }
      if (
        command.nextCharId !== command.currentCharId
        && characters.some((character) => character !== target && character.id === command.nextCharId)
      ) {
        throw new Error(`Duplicate character id: ${command.nextCharId}`);
      }
      target.id = command.nextCharId;
      return [command.nextCharId];
    }
    case 'update-character-name': {
      const target = requireCharacter(characters, command.charId);
      target.name = command.nextName;
      return [command.charId];
    }
    case 'remove-character': {
      const index = characters.findIndex((character) => character.id === command.charId);
      if (index === -1) throw new Error(`Character not found: ${command.charId}`);
      characters.splice(index, 1);
      return [command.charId];
    }
    case 'set-character-color': {
      const target = requireCharacter(characters, command.charId);
      if (!command.color) {
        delete target.color;
      } else {
        target.color = command.color;
      }
      return [command.charId];
    }
    case 'set-character-model': {
      const target = requireCharacter(characters, command.charId);
      if (command.model?.trim()) {
        target.model = command.model;
      } else {
        delete target.model;
      }
      return [command.charId];
    }
    case 'set-character-voice-profile': {
      const target = requireCharacter(characters, command.charId);
      if (command.voiceProfileId?.trim()) {
        target.voiceProfileId = command.voiceProfileId;
      } else {
        delete target.voiceProfileId;
      }
      return [command.charId];
    }
    case 'add-character-variant': {
      const target = requireCharacter(characters, command.charId);
      const model = command.model.trim();
      if (!model) throw new Error('Variant model is required');
      const variants = [
        ...(target.variants ?? []),
        { name: `副模型${(target.variants?.length ?? 0) + 1}`, model },
      ];
      target.variants = variants;
      return [command.charId];
    }
    case 'update-character-variant-name': {
      const target = requireCharacter(characters, command.charId);
      const variants = cloneVariants(target);
      if (!variants[command.variantIndex]) throw new Error(`Variant not found: ${command.charId}#${command.variantIndex}`);
      variants[command.variantIndex] = { ...variants[command.variantIndex], name: command.nextName };
      target.variants = variants;
      return [command.charId];
    }
    case 'update-character-variant-model': {
      const target = requireCharacter(characters, command.charId);
      const variants = cloneVariants(target);
      if (!variants[command.variantIndex]) throw new Error(`Variant not found: ${command.charId}#${command.variantIndex}`);
      const model = command.nextModel.trim();
      if (!model) throw new Error('Variant model is required');
      variants[command.variantIndex] = { ...variants[command.variantIndex], model };
      target.variants = variants;
      return [command.charId];
    }
    case 'remove-character-variant': {
      const target = requireCharacter(characters, command.charId);
      const variants = cloneVariants(target);
      if (!variants[command.variantIndex]) throw new Error(`Variant not found: ${command.charId}#${command.variantIndex}`);
      variants.splice(command.variantIndex, 1);
      target.variants = variants;
      return [command.charId];
    }
    case 'add-template-characters': {
      const existingById = new Map(characters.map((character) => [character.id, character]));
      const imported: string[] = [];
      for (const character of command.characters) {
        const existing = existingById.get(character.id);
        if (existing) {
          const currentVariants = existing.variants ?? [];
          const addedVariants = (character.variants ?? []).filter((candidate) => (
            !currentVariants.some((variant) => (
              variant.model === candidate.model || variant.name === candidate.name
            ))
          ));
          if (addedVariants.length === 0) continue;
          existing.variants = [...currentVariants, ...cloneJson(addedVariants)];
          imported.push(character.id);
          continue;
        }
        const cloned = cloneJson(character);
        characters.push(cloned);
        existingById.set(character.id, cloned);
        imported.push(character.id);
      }
      return imported;
    }
  }
}

function requireCharacter(characters: SceneCharacter[], charId: string): SceneCharacter {
  const target = characters.find((character) => character.id === charId);
  if (!target) throw new Error(`Character not found: ${charId}`);
  return target;
}

function cloneVariants(character: SceneCharacter): SceneCharacterVariant[] {
  return cloneJson(character.variants ?? []);
}

function nextCharacterId(characters: SceneCharacter[]): string {
  const numericIds = characters
    .map((character) => Number.parseInt(character.id, 10))
    .filter((value) => !Number.isNaN(value));

  return String((numericIds.length > 0 ? Math.max(...numericIds) : 0) + 1);
}

function rewriteSceneDocumentCharacterReferences(
  document: CurrentSceneDocument,
  command: CharacterDirectoryCommand,
  affectedStatementIds: Set<string>,
  affectedCompanionLocators: SemanticCompanionLocator[],
): void {
  for (const statement of document.statements) {
    if (rewriteStatementCharacterReferences(statement, command)) {
      affectedStatementIds.add(statement.id);
    }

    for (const companion of statement.companions ?? []) {
      if (rewriteCompanionCharacterReferences(companion, command)) {
        affectedStatementIds.add(statement.id);
        affectedCompanionLocators.push({
          statementId: statement.id,
          companionId: companion.id,
        });
      }
    }
  }
}

function rewriteStatementCharacterReferences(
  statement: SceneStatement,
  command: CharacterDirectoryCommand,
): boolean {
  switch (statement.type) {
    case 'dialogue':
      return rewriteDialogueParams(statement.params, command);
    case 'characterPresence':
      return rewriteCharacterPresenceParams(statement.params, command);
    case 'characterTransform':
      return rewriteCharacterTransformParams(statement.params, command);
    case 'characterPerformance':
      return rewriteCharacterPerformanceParams(statement.params, command);
    case 'camera':
      return rewriteCameraParams(statement.params, command);
    case 'customAnimation':
      return rewriteCustomAnimationParams(statement.params, command);
    case 'environmentLayer':
    case 'visualStyle':
    case 'filterAdd':
    case 'filterChange':
    case 'filterReset':
    case 'lighting':
    case 'audio':
    case 'graphicLayer':
      return false;
  }
}

function rewriteCompanionCharacterReferences(
  companion: DialogueCompanion,
  command: CharacterDirectoryCommand,
): boolean {
  return rewriteStatementCharacterReferences({
    id: companion.id,
    time: 0,
    type: companion.type,
    params: companion.params,
  } as SceneStatement, command);
}

function rewriteDialogueParams(params: DialogueParams, command: CharacterDirectoryCommand): boolean {
  if (command.kind === 'update-character-id' && params.speakerId === command.currentCharId) {
    params.speakerId = command.nextCharId;
    return true;
  }
  if (command.kind === 'update-character-name' && params.speakerId === command.charId) {
    params.speaker = command.nextName;
    return true;
  }
  return false;
}

function rewriteCharacterPresenceParams(
  params: CharacterPresenceParams,
  command: CharacterDirectoryCommand,
): boolean {
  if (command.kind === 'update-character-id' && params.id === command.currentCharId) {
    params.id = command.nextCharId;
    return true;
  }
  if (command.kind === 'set-character-model' && params.mode === 'enter' && params.id === command.charId) {
    params.model = command.model ?? '';
    return true;
  }
  return false;
}

function rewriteCharacterTransformParams(
  params: CharacterTransformParams,
  command: CharacterDirectoryCommand,
): boolean {
  if (command.kind !== 'update-character-id' || params.id !== command.currentCharId) return false;
  params.id = command.nextCharId;
  return true;
}

function rewriteCharacterPerformanceParams(
  params: CharacterPerformanceParams,
  command: CharacterDirectoryCommand,
): boolean {
  if (command.kind !== 'update-character-id') return false;
  let changed = false;
  if (params.target === command.currentCharId) {
    params.target = command.nextCharId;
    changed = true;
  }
  if (params.lookAt?.target === command.currentCharId) {
    params.lookAt = { ...params.lookAt, target: command.nextCharId };
    changed = true;
  }
  return changed;
}

function rewriteCameraParams(params: CameraParams, command: CharacterDirectoryCommand): boolean {
  if (command.kind !== 'update-character-id') return false;
  switch (params.mode) {
    case 'focus':
    case 'follow':
    case 'hitchcock':
      if (params.target !== command.currentCharId) return false;
      params.target = command.nextCharId;
      return true;
    case 'move':
    case 'path':
    case 'shake':
    case 'reset':
      return false;
  }
}

function rewriteCustomAnimationParams(
  params: CustomAnimationParams,
  command: CharacterDirectoryCommand,
): boolean {
  if (command.kind !== 'update-character-id' || params.target !== command.currentCharId) return false;
  params.target = command.nextCharId;
  return true;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
