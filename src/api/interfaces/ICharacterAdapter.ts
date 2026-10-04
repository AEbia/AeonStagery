import type { CharacterConfig } from '../types/character';
import type { Cubism2MotionSamplerTarget } from '../../engine/live2d/cubism2MotionSampler';

export interface ICharacterAdapter {
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
  getCoreModel(id: string): any;
  getModel(id: string): any;
  hasCharacter(id: string): boolean;
  getAllCharacters(): Map<string, any>;
  /** Concrete Cubism 2.1 sampling targets of a loaded character (ADR-0029 conversion). */
  getCubism2SamplerTargets?(characterId: string): readonly Cubism2MotionSamplerTarget[];
  getMotionDuration?(characterId: string, motionKey: string): number;
}
