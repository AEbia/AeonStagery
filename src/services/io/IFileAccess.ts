export interface IFileAccess {
  readAsset(relativePath: string): Promise<{ data: string; path: string }>;
  readFile(path: string): Promise<{ data: string; path: string }>;
  readBinaryFile?(path: string): Promise<{ data: ArrayBuffer; path: string }>;
  showOpenDialog(): Promise<{ data: string; path: string } | null>;
  showSaveDialog(): Promise<string | null>;
  writeFile(path: string, data: string): Promise<void>;
  replaceFile?(temporaryPath: string, destinationPath: string): Promise<void>;
  writeBinaryFile?(path: string, data: ArrayBuffer): Promise<void>;
  ensureDir(path: string): Promise<void>;
  copyFile(sourcePath: string, destPath: string): Promise<void>;
  readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean; path: string }>>;
  exists(path: string): Promise<boolean>;
  /** lstat-style metadata used by the bounded project read ports; null when unavailable. */
  stat?(path: string): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    sizeBytes: number;
    mtimeMs: number;
  } | null>;
  /** Canonical resolved path used for root-containment checks. */
  realpath?(path: string): Promise<string>;
  join(...parts: string[]): Promise<string>;
  dirname(path: string): Promise<string>;
  basename(path: string): Promise<string>;
  extname(path: string): Promise<string>;
}
