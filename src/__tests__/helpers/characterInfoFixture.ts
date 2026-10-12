import type { CharacterConfig, CharacterInfo } from '../../api/types/character';
import type { Live2DRuntimeDescriptor } from '../../engine/Live2DRuntimeResolver';
import { getLive2DRuntimeCapabilities, type Live2DModelHandle } from '../../engine/live2d/runtime/Live2DRuntimeControlModule';

/** Legacy SDK fixtures stay in tests; coordinator callers receive only neutral data. */
export function characterInfoFixture(entry: {
  id?: string;
  modelPath?: string;
  config?: CharacterConfig;
  runtime?: Partial<Live2DRuntimeDescriptor>;
  runtimeHandle?: Pick<Live2DModelHandle, 'capabilities'>;
} | undefined, id = 'char1'): CharacterInfo | null {
  if (!entry) return null;
  const runtime: Live2DRuntimeDescriptor = {
    runtimeFamily: entry.runtime?.runtimeFamily ?? 'cubism2',
    adapterId: entry.runtime?.adapterId ?? 'pixi-live2d-display-cubism2',
    supported: entry.runtime?.supported ?? true,
  };
  return {
    id: entry.id ?? id, modelPath: entry.modelPath ?? 'model.json', config: entry.config ?? {},
    adapterId: runtime.adapterId,
    determinism: getLive2DRuntimeCapabilities({ runtime, runtimeHandle: entry.runtimeHandle }).determinism,
  };
}
