export interface DirectoryPickerPort {
  showOpen(options: { title: string; properties: string[] }): Promise<{ canceled: boolean; filePaths?: string[] }>;
}

export interface SettingsDialogPolicy {
  pickDirectory(onPick: (path: string) => void): Promise<void>;
}

export function createSettingsDialogPolicy(directoryPicker: DirectoryPickerPort): SettingsDialogPolicy {
  return {
    async pickDirectory(onPick) {
      try {
        const result = await directoryPicker.showOpen({
          title: '选择目录',
          properties: ['openDirectory'],
        });
        if (!result.canceled && result.filePaths?.[0]) {
          onPick(result.filePaths[0]);
        }
      } catch (error) {
        console.error('Failed to open directory dialog:', error);
      }
    },
  };
}
