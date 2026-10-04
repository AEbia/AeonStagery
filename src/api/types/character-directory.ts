import type { SceneMeta } from './scene-common';

type SceneCharacter = NonNullable<SceneMeta['characters']>[number];

export type CharacterDirectoryOrigin = 'timeline-list-view' | 'workspace-tools-panel' | 'template-config' | 'voice-workbench';

interface BaseCharacterDirectoryCommand {
  origin: CharacterDirectoryOrigin;
}

export interface AddCharacterDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'add-character';
}

export interface UpdateCharacterIdDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'update-character-id';
  currentCharId: string;
  nextCharId: string;
}

export interface UpdateCharacterNameDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'update-character-name';
  charId: string;
  nextName: string;
}

export interface RemoveCharacterDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'remove-character';
  charId: string;
}

export interface SetCharacterColorDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'set-character-color';
  charId: string;
  color?: string;
}

export interface SetCharacterModelDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'set-character-model';
  charId: string;
  model?: string;
}

export interface SetCharacterVoiceProfileDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'set-character-voice-profile';
  charId: string;
  voiceProfileId?: string;
}

export interface AddCharacterVariantDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'add-character-variant';
  charId: string;
  model: string;
}

export interface UpdateCharacterVariantNameDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'update-character-variant-name';
  charId: string;
  variantIndex: number;
  nextName: string;
}

export interface UpdateCharacterVariantModelDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'update-character-variant-model';
  charId: string;
  variantIndex: number;
  nextModel: string;
}

export interface RemoveCharacterVariantDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'remove-character-variant';
  charId: string;
  variantIndex: number;
}

export interface AddTemplateCharactersDirectoryCommand extends BaseCharacterDirectoryCommand {
  kind: 'add-template-characters';
  characters: SceneCharacter[];
}

export type CharacterDirectoryCommand =
  | AddCharacterDirectoryCommand
  | UpdateCharacterIdDirectoryCommand
  | UpdateCharacterNameDirectoryCommand
  | RemoveCharacterDirectoryCommand
  | SetCharacterColorDirectoryCommand
  | SetCharacterModelDirectoryCommand
  | SetCharacterVoiceProfileDirectoryCommand
  | AddCharacterVariantDirectoryCommand
  | UpdateCharacterVariantNameDirectoryCommand
  | UpdateCharacterVariantModelDirectoryCommand
  | RemoveCharacterVariantDirectoryCommand
  | AddTemplateCharactersDirectoryCommand;

export interface CharacterDirectoryReceipt {
  kind: CharacterDirectoryCommand['kind'];
  origin: CharacterDirectoryOrigin;
  affectedCharacterIds: string[];
  affectedActionIds: string[];
}
