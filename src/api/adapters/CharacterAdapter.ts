import { live2DManager } from '../../engine/Live2DManager';
import type { CharacterConfig, CharacterTransformConfig } from '../types/character';
import type { ICharacterAdapter } from '../../api/interfaces';

export class CharacterAdapter implements ICharacterAdapter {
  getParameterMetadata(characterId: string) {
    return live2DManager.getParameterMetadata(characterId);
  }

  async add(id: string, modelPath: string, config?: CharacterConfig): Promise<void> {
    await live2DManager.addCharacter(id, modelPath, config);
  }

  async remove(id: string): Promise<void> {
    live2DManager.removeCharacter(id);
  }

  playMotion(id: string, motionKey: string): void {
    live2DManager.playMotion(id, motionKey);
  }

  stopAllMotions(id: string): void {
    live2DManager.stopAllMotions(id);
  }

  setExpression(id: string, expressionName: string): void {
    live2DManager.setExpression(id, expressionName);
  }

  lookAt(id: string, x: number, y: number, duration?: number): void {
    live2DManager.lookAt(id, x, y, duration);
  }

  transform(id: string, config: CharacterTransformConfig): void {
    live2DManager.transform(id, config);
  }

  getPoint(id: string, pointName: 'head' | 'chest' | 'feet' | 'center', out?: { x: number; y: number }): { x: number; y: number } | null {
    return live2DManager.getPoint(id, pointName, out);
  }

  listCharacters(): string[] {
    return live2DManager.listCharacters();
  }

  getModelDataFromPath(modelPath: string): Promise<{ motions: string[]; expressions: string[] }> {
    return live2DManager.getModelDataFromPath(modelPath);
  }

  getCoreModel(id: string): any { return live2DManager.getCoreModel(id); }
  getModel(id: string): any { return live2DManager.getModel(id); }
  hasCharacter(id: string): boolean { return live2DManager.hasCharacter(id); }
  getAllCharacters(): Map<string, any> { return live2DManager.getAllCharacters(); }
  getCubism2SamplerTargets(characterId: string): readonly import('../../engine/live2d/cubism2MotionSampler').Cubism2MotionSamplerTarget[] {
    return live2DManager.getCubism2SamplerTargets(characterId);
  }
  getMotionDuration(characterId: string, motionKey: string): number {
    return live2DManager.getMotionDuration(characterId, motionKey);
  }
}
