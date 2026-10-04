interface StoreLike {
  filePath: string | null;
  version: number;
  _listeners: Set<() => void>;
  getCurrentSceneDocumentSnapshot(): unknown | null;
}

interface AdapterLike {
  forceSave(): Promise<void>;
}

export class AutoSaveDaemon {
  private store: StoreLike | null = null;
  private adapter: AdapterLike | null = null;
  private diskSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  private unsubStore: (() => void) | null = null;
  private lastSavedVersion: number = 0;
  private disposed = false;

  attach(
    documentStore: StoreLike,
    documentAdapter: AdapterLike,
  ): () => void {
    if (this.unsubStore) {
      this.dispose();
    }

    this.store = documentStore;
    this.adapter = documentAdapter;
    this.disposed = false;
    this.lastSavedVersion = documentStore.version;

    const storeListener = () => {
      if (this.disposed) return;
      if (documentStore.version === this.lastSavedVersion) return;
      if (!documentStore.getCurrentSceneDocumentSnapshot() || !documentStore.filePath) return;

      // Reset debounce timer on each change
      if (this.diskSaveTimeout) clearTimeout(this.diskSaveTimeout);
      this.scheduleDiskSave();
    };

    documentStore._listeners.add(storeListener);
    this.unsubStore = () => { documentStore._listeners.delete(storeListener); };

    return () => this.dispose();
  }

  private scheduleDiskSave(): void {
    this.diskSaveTimeout = setTimeout(() => {
      this.diskSaveTimeout = null;
      if (this.disposed || !this.adapter || !this.store) return;

      this.lastSavedVersion = this.store.version; // optimistically mark to prevent re-trigger
      // Delegate save status entirely to SceneFileService.save()
      this.adapter.forceSave().catch((err) => {
        console.error('[AutoSaveDaemon] auto-save trigger failed:', err);
      });
    }, 100);
  }

  dispose(): void {
    this.disposed = true;
    if (this.diskSaveTimeout) clearTimeout(this.diskSaveTimeout);
    if (this.unsubStore) {
      this.unsubStore();
      this.unsubStore = null;
    }
    this.store = null;
    this.adapter = null;
    this.lastSavedVersion = 0;
  }
}
