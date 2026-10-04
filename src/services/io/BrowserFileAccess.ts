import { IFileAccess } from './IFileAccess';

export class BrowserFileAccess implements IFileAccess {
  async readAsset(relativePath: string): Promise<{ data: string; path: string }> {
    const response = await fetch('/' + relativePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch asset ${relativePath}: ${response.statusText}`);
    }
    const data = await response.text();
    return { data, path: relativePath };
  }

  async readFile(path: string): Promise<{ data: string; path: string }> {
    return this.readAsset(path);
  }

  async readBinaryFile(path: string): Promise<{ data: ArrayBuffer; path: string }> {
    const response = await fetch('/' + path);
    if (!response.ok) {
      throw new Error(`Failed to fetch binary file ${path}: ${response.statusText}`);
    }
    return { data: await response.arrayBuffer(), path };
  }

  async showOpenDialog(): Promise<{ data: string; path: string } | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';

      let isChanged = false;
      input.onchange = (e: any) => {
        isChanged = true;
        const file = e.target.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = (evt: any) => {
          resolve({ data: evt.target.result as string, path: file.name });
        };
        reader.onerror = () => {
          resolve(null);
        };
        reader.readAsText(file);
      };

      window.addEventListener('focus', () => {
        setTimeout(() => {
          if (!isChanged) {
            resolve(null);
          }
        }, 300);
      }, { once: true });

      input.click();
    });
  }

  async showSaveDialog(): Promise<string | null> {
    return 'scene.json';
  }

  async writeFile(path: string, data: string): Promise<void> {
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'scene.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async ensureDir(_path: string): Promise<void> {
    return;
  }

  async copyFile(_sourcePath: string, _destPath: string): Promise<void> {
    throw new Error('copyFile is not supported in browser mode');
  }

  async readDir(_path: string): Promise<Array<{ name: string; isDirectory: boolean; path: string }>> {
    return [];
  }

  async exists(_path: string): Promise<boolean> {
    return false;
  }

  async stat(): Promise<null> {
    return null;
  }

  async realpath(path: string): Promise<string> {
    return path;
  }

  async join(...parts: string[]): Promise<string> {
    return parts.join('/').replace(/\/+/g, '/');
  }

  async dirname(path: string): Promise<string> {
    const clean = path.replace(/\\/g, '/');
    const idx = clean.lastIndexOf('/');
    return idx === -1 ? '.' : clean.slice(0, idx);
  }

  async basename(path: string): Promise<string> {
    const clean = path.replace(/\\/g, '/');
    return clean.split('/').filter(Boolean).pop() || clean;
  }

  async extname(path: string): Promise<string> {
    const fileName = await this.basename(path);
    const idx = fileName.lastIndexOf('.');
    return idx === -1 ? '' : fileName.slice(idx);
  }
}
