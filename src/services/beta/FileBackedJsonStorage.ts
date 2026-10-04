export interface JsonFileAccess {
  readFile(path: string): Promise<string>;
  writeFile(path: string, value: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  dirname(path: string): string;
}

export class FileBackedJsonStorage {
  constructor(private readonly fileAccess: JsonFileAccess, private readonly filePath: string) {}

  async load<T>(fallback: T): Promise<T> {
    try { return JSON.parse(await this.fileAccess.readFile(this.filePath)) as T; }
    catch { return fallback; }
  }

  async save<T>(value: T): Promise<void> {
    await this.fileAccess.ensureDir(this.fileAccess.dirname(this.filePath));
    await this.fileAccess.writeFile(this.filePath, JSON.stringify(value));
  }
}
