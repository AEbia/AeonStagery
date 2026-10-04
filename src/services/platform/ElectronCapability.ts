import { BrowserFileAccess } from '../io/BrowserFileAccess';
import { ElectronFileAccess } from '../io/ElectronFileAccess';
import type { IFileAccess } from '../io/IFileAccess';
import type { ElectronCapability } from '../../api/interfaces/ElectronCapability';

export function getWindowElectronCapability(targetWindow: Window | undefined = typeof window !== 'undefined' ? window : undefined): ElectronCapability | null {
  return targetWindow?.aeonStageryAPI ?? null;
}

export function createFileAccessForCapability(capability: ElectronCapability | null): IFileAccess {
  return capability ? new ElectronFileAccess(capability) : new BrowserFileAccess();
}
