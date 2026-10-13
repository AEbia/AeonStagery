import { live2DManager } from '../../engine/Live2DManager';
import type { CharacterConfig, CharacterTransformConfig } from '../types/character';
import type { ICharacterAdapter } from '../../api/interfaces';
import type { Live2DParameterEdit } from '../types/live2d-parameter-animation';
import type { Live2DMotionSamplingOptions, Live2DMotionSamplingResult } from '../../engine/runtime/Live2DRuntimeContracts';

export class CharacterAdapter implements ICharacterAdapter {
  constructor(private readonly manager = live2DManager) {}

  inspectParameters(characterId: string) {
    return this.manager.inspectParameters(characterId);
  }

  editParameters(characterId: string, edits: readonly Live2DParameterEdit[]) {
    return this.manager.editParameters(characterId, edits);
  }

  getParameterMetadata(characterId: string) {
    return this.manager.getParameterMetadata(characterId);
  }

  async add(id: string, modelPath: string, config?: CharacterConfig): Promise<void> {
    await this.manager.addCharacter(id, modelPath, config);
  }

  async remove(id: string): Promise<void> {
    this.manager.removeCharacter(id);
  }

  playMotion(id: string, motionKey: string): void {
    this.manager.playMotion(id, motionKey);
  }

  stopAllMotions(id: string): void {
    this.manager.stopAllMotions(id);
  }

  setExpression(id: string, expressionName: string): void {
    this.manager.setExpression(id, expressionName);
  }

  lookAt(id: string, x: number, y: number, duration?: number): void {
    this.manager.lookAt(id, x, y, duration);
  }

  transform(id: string, config: CharacterTransformConfig): void {
    this.manager.transform(id, config);
  }

  getPoint(id: string, pointName: 'head' | 'chest' | 'feet' | 'center', out?: { x: number; y: number }): { x: number; y: number } | null {
    return this.manager.getPoint(id, pointName, out);
  }

  listCharacters(): string[] {
    return this.manager.listCharacters();
  }

  getModelDataFromPath(modelPath: string): Promise<{ motions: string[]; expressions: string[] }> {
    return this.manager.getModelDataFromPath(modelPath);
  }

  getCharacterInfo(id: string) { return this.manager.getCharacterInfo(id); }
  listCharacterInfo() { return this.manager.listCharacterInfo(); }
  getDisplayObject(id: string) { return this.manager.getDisplayObject(id); }
  hasCharacter(id: string): boolean { return this.manager.hasCharacter(id); }
  sampleMotion(characterId: string, motionKey: string, options: Live2DMotionSamplingOptions): Promise<Live2DMotionSamplingResult> {
    return this.manager.sampleMotion(characterId, motionKey, options);
  }
  getMotionDuration(characterId: string, motionKey: string): number {
    return this.manager.getMotionDuration(characterId, motionKey);
  }
}
