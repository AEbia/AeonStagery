import type { CharacterEntry } from '../../Live2DConfig';
import { getLive2DRuntimeAdapter } from '../../Live2DRuntimeAdapter';
import type { Live2DModelHandle } from './Live2DRuntimeControlModule';

/** Reuse the loaded model's binding; lazily bind only legacy/test entries. */
export function getBoundRuntimeHandle(entry: CharacterEntry): Live2DModelHandle | null {
  if (entry.runtimeHandle) return entry.runtimeHandle;
  if (!entry.model) return null;
  const handle = getLive2DRuntimeAdapter(entry.runtime).createModelHandle(entry.id, entry.model, entry.runtime);
  entry.runtimeHandle = handle;
  return handle;
}
