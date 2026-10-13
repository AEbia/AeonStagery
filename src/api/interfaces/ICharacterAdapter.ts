import type { CharacterConfig, CharacterInfo } from '../types/character';
import type { Container } from 'pixi.js';
import type { Live2DParameterEdit, Live2DParameterEditResult, Live2DParameterInspection } from '../types/live2d-parameter-animation';
import type { Live2DMotionSamplingOptions, Live2DMotionSamplingResult } from '../../engine/runtime/Live2DRuntimeContracts';

export interface ICharacterAdapter {
  inspectParameters(characterId: string): readonly Live2DParameterInspection[] | null;
  editParameters(characterId: string, edits: readonly Live2DParameterEdit[]): Live2DParameterEditResult;
  getParameterMetadata?(characterId: string): readonly import('../types/live2d-parameter-animation').Live2DParameterMetadata[];
  add(id: string, modelPath: string, config?: CharacterConfig): Promise<void>;
  remove(id: string): Promise<void>;
  playMotion(id: string, motionKey: string): void;
  stopAllMotions(id: string): void;
  setExpression(id: string, expressionName: string): void;
  lookAt(id: string, x: number, y: number, duration?: number): void;
  getPoint(id: string, pointName: 'head' | 'chest' | 'feet' | 'center', out?: { x: number; y: number }): { x: number; y: number } | null;
  listCharacters(): string[];
  getModelDataFromPath(modelPath: string): Promise<{ motions: string[]; expressions: string[] }>;
  getCharacterInfo(id: string): CharacterInfo | null;
  listCharacterInfo(): readonly CharacterInfo[];
  getDisplayObject(id: string): Container | null;
  hasCharacter(id: string): boolean;
  sampleMotion?(characterId: string, motionKey: string, options: Live2DMotionSamplingOptions): Promise<Live2DMotionSamplingResult>;
  getMotionDuration?(characterId: string, motionKey: string): number;
}
