import type { CharacterDirectoryCommand } from '../../api/types/character-directory';
import type { SceneMeta } from '../../api/types/scene-common';

export type WorkspaceToolTab = 'characters' | 'snapshot' | 'script' | 'diagnostics';
export type WorkspaceToolsMode = 'docked' | 'detached';
export type WorkspaceCharacterCommand = CharacterDirectoryCommand extends infer Command
  ? Command extends CharacterDirectoryCommand
    ? Omit<Command, 'origin'>
    : never
  : never;

export interface WorkspaceRuntimeCharacterSnapshot {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  scale: number;
  opacity: number;
  parameters: Array<{
    index: number;
    name: string;
    value: number;
  }>;
}

export interface WorkspaceRuntimeSnapshot {
  playing: boolean;
  camera: {
    x: number;
    y: number;
    zoom: number;
    rotation: number;
  };
  characters: WorkspaceRuntimeCharacterSnapshot[];
}

export interface WorkspaceToolsSceneIdentity {
  sceneId: string;
  filePath?: string;
  projectRoot?: string;
}

export function areWorkspaceToolsSceneIdentitiesEqual(
  left: WorkspaceToolsSceneIdentity | null | undefined,
  right: WorkspaceToolsSceneIdentity | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.sceneId === right.sceneId
    && left.filePath === right.filePath
    && left.projectRoot === right.projectRoot;
}

export interface WorkspaceToolsSnapshot {
  sceneMeta: SceneMeta | null;
  timelineActionTimesById: Record<string, number>;
  sceneIdentity: WorkspaceToolsSceneIdentity | null;
  rawScript: string;
  filePath?: string;
  projectName?: string;
  projectRoot?: string;
  selectedActionIds: string[];
  issues: Array<{
    severity: 'error' | 'warning' | 'info';
    message: string;
    actionId?: string;
    actionType?: string;
  }>;
  saveStatus: 'idle' | 'dirty' | 'saving' | 'error';
  theme: 'light' | 'dark' | 'system';
  activeTab: WorkspaceToolTab;
}

export type WorkspaceToolsCommand =
  | { type: 'set-tab'; tab: WorkspaceToolTab }
  | { type: 'select-action'; actionId?: string; time?: number }
  | {
      type: 'apply-raw-script';
      requestId: string;
      rawScript: string;
      sceneIdentity: WorkspaceToolsSceneIdentity;
    }
  | { type: 'character-command'; command: WorkspaceCharacterCommand }
  | { type: 'reload-character'; charId: string }
  | { type: 'set-character-parameter'; charId: string; parameterIndex: number; value: number }
  | { type: 'save' };

export interface WorkspaceToolsCommandResult {
  type: 'apply-raw-script-result';
  requestId: string;
  sceneIdentity: WorkspaceToolsSceneIdentity;
  success: boolean;
  error?: string;
}

export interface WorkspaceToolsWindowState {
  open: boolean;
}
