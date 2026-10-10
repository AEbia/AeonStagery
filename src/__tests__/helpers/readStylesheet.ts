import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** jsdom does not load local CSS imports; inline them in their production order. */
export function readStylesheet(relativePath: string): string {
  const filename = resolve(process.cwd(), relativePath);
  return readFileSync(filename, 'utf8').replace(
    /^@import\s+['"]([^'"]+)['"];\s*$/gm,
    (_import, importedPath: string) => readStylesheet(resolve(dirname(filename), importedPath)),
  );
}
