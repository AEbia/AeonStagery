import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(process.cwd(), 'src');
const LOCAL_CUSTOM_PROPERTIES = new Set(['track-color']);

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return /.(css|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('design token contract', () => {
  it('does not reference undefined global CSS variables', () => {
    const files = listSourceFiles(SOURCE_ROOT);
    const references = new Set<string>();
    const definitions = new Set<string>();

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/var\(--([a-z0-9-]+)\)/g)) {
        references.add(match[1]);
      }
      for (const match of source.matchAll(/--([a-z0-9-]+)\s*:/g)) {
        definitions.add(match[1]);
      }
    }

    const undefinedTokens = [...references]
      .filter((token) => !definitions.has(token) && !LOCAL_CUSTOM_PROPERTIES.has(token))
      .sort();

    expect(undefinedTokens).toEqual([]);
  });
});
