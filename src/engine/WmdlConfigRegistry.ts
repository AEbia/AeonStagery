/**
 * AeonStagery — WMDL Configuration Registry
 *
 * Stores parsed, relative-path resolved configurations for composed Live2D (.wmdl) models
 * purely in memory. Instantiated per session/bootstrap to prevent global state leaks and
 * ensure 100% test isolation.
 */
export class WmdlConfigRegistry {
  private configs = new Map<string, any>();

  private normalize(p: string): string {
    if (!p) return '';
    try {
      p = decodeURIComponent(p);
    } catch {}
    p = p.replace(/\\/g, '/');
    p = p.replace(/^asset:\/\/localhost\//i, '');
    p = p.replace(/^asset:\/\/\//i, '');
    p = p.replace(/^asset:\/\//i, '');
    p = p.replace(/^file:\/\/\//i, '');
    p = p.replace(/^file:\/\//i, '');
    return p.toLowerCase().trim();
  }

  /**
   * Retrieve composed config by model path
   */
  public get(path: string): any | undefined {
    if (!path) return undefined;
    const query = this.normalize(path);
    
    // 1. Direct match on normalized keys
    for (const [key, val] of this.configs.entries()) {
      const normKey = this.normalize(key);
      if (normKey === query) {
        return val;
      }
    }

    // 2. Suffix match (e.g., query is an absolute path ending with the registered relative path, or vice versa)
    for (const [key, val] of this.configs.entries()) {
      const normKey = this.normalize(key);
      if (query.endsWith(normKey) || normKey.endsWith(query)) {
        return val;
      }
    }

    return undefined;
  }

  /**
   * Register a composed config
   */
  public register(path: string, config: any): void {
    this.configs.set(path, config);
  }

  /**
   * Clear all registered configs to prevent stale state bleed
   */
  public clear(): void {
    this.configs.clear();
  }
}
