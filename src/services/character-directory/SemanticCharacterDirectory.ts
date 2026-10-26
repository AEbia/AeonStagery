import type {
  CharacterDirectoryCommand,
  CharacterDirectoryOrigin,
} from '../../api/types/character-directory';
import type {
  CharacterPresenceParams,
  DialogueCompanion,
  DialogueParams,
  CurrentSceneDocument,
  CurrentSceneMeta,
  SceneStatement,
} from '../../api/types/semantic-scene';
import {
  sceneDocumentCodec,
  sceneStatementDefinitionRegistry,
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
    new Set((document.meta.characters ?? []).map((character) => character.id)),
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
  characterIds: ReadonlySet<string>,
  affectedStatementIds: Set<string>,
  affectedCompanionLocators: SemanticCompanionLocator[],
): void {
  for (const statement of document.statements) {
    if (rewriteStatementCharacterReferences(statement, command, characterIds)) {
      affectedStatementIds.add(statement.id);
    }

    for (const companion of statement.companions ?? []) {
      if (rewriteCompanionCharacterReferences(companion, command, characterIds)) {
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
  statement: SceneStatement | DialogueCompanion,
  command: CharacterDirectoryCommand,
  characterIds: ReadonlySet<string>,
): boolean {
  if (command.kind === 'update-character-id') {
    return sceneStatementDefinitionRegistry.renameCharacterReferences(statement, command.currentCharId, command.nextCharId, characterIds);
  }
  if (statement.type === 'dialogue') return rewriteDialogueParams(statement.params, command);
  if (statement.type === 'characterPresence') return rewriteCharacterPresenceParams(statement.params, command);
  return false;
}

function rewriteCompanionCharacterReferences(
  companion: DialogueCompanion,
  command: CharacterDirectoryCommand,
  characterIds: ReadonlySet<string>,
): boolean {
  return rewriteStatementCharacterReferences(companion, command, characterIds);
}

function rewriteDialogueParams(params: DialogueParams, command: CharacterDirectoryCommand): boolean {
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
  if (command.kind === 'set-character-model' && params.mode === 'enter' && params.id === command.charId) {
    params.model = command.model ?? '';
    return true;
  }
  return false;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
