import type { DirectoryPickerPort } from './SettingsDialogPolicy';

export function createWindowDirectoryPicker(): DirectoryPickerPort | null {
  return window.aeonStageryAPI?.dialog ?? null;
}
