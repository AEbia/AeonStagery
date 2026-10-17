import { describe, expect, it } from 'vitest';
import {
  dialogueParamsSignature,
  findWebGalImportConflicts,
  hashImportSource,
  normalizeScssForHashing,
  scssContentHash,
  slugifyWebGalPackageName,
  stableStringify,
  uniquePackageName,
  WEBGAL_PACKAGE_ID_PREFIX,
} from '../services/import/webgal/WebGalScssPackageNaming';

describe('WebGalScssPackageNaming', () => {
  describe('package names', () => {
    it('keeps Chinese names and collapses path-hostile characters', () => {
      expect(slugifyWebGalPackageName('仿番剧字幕')).toBe('仿番剧字幕');
      expect(slugifyWebGalPackageName('MyGO Theme v3.2.1 pure')).toBe('MyGO-Theme-v3.2.1-pure');
      expect(slugifyWebGalPackageName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
      expect(slugifyWebGalPackageName('   spaced   out   ')).toBe('spaced-out');
    });

    it('strips leading and trailing dots so a name cannot escape its directory', () => {
      expect(slugifyWebGalPackageName('..')).toBe('webgal-template');
      expect(slugifyWebGalPackageName('../evil')).toBe('evil');
      expect(slugifyWebGalPackageName('.hidden.')).toBe('hidden');
    });

    it('falls back to a usable name and caps the length', () => {
      expect(slugifyWebGalPackageName('')).toBe('webgal-template');
      expect(slugifyWebGalPackageName('   ')).toBe('webgal-template');
      expect(slugifyWebGalPackageName('x'.repeat(120))).toHaveLength(48);
    });

    it('numbers collisions instead of adding a random suffix', () => {
      expect(uniquePackageName('theme', [])).toBe('theme');
      expect(uniquePackageName('theme', ['theme'])).toBe('theme-2');
      expect(uniquePackageName('theme', ['theme', 'theme-2'])).toBe('theme-3');
      expect(uniquePackageName('theme', ['other'])).toBe('theme');
      // A prefixed id keeps its prefix when numbered.
      const id = `${WEBGAL_PACKAGE_ID_PREFIX}theme`;
      expect(uniquePackageName(id, [id])).toBe(`${id}-2`);
    });
  });

  describe('stylesheet fingerprint', () => {
    const base = '.TextBox_main { color: red; height: 330px; }';

    it('ignores layout and comments', () => {
      const reformatted = [
        '/* MyGO theme */',
        '.TextBox_main {',
        '  color: red; // stage pixels',
        '  // trailing note',
        '  height: 330px;',
        '}',
      ].join('\n');
      expect(normalizeScssForHashing(reformatted)).toBe(normalizeScssForHashing(base));
      expect(scssContentHash(reformatted)).toBe(scssContentHash(base));
    });

    it('keeps a url scheme intact while dropping comments', () => {
      const withUrl = '.TextBox_Background { background: url(https://example.com/bg.png); }';
      expect(normalizeScssForHashing(withUrl)).toContain('url(https://example.com/bg.png)');
    });

    it('changes as soon as a value changes', () => {
      expect(scssContentHash('.TextBox_main { color: red; height: 331px; }'))
        .not.toBe(scssContentHash(base));
      expect(scssContentHash('.TextBox_main { color: blue; height: 330px; }'))
        .not.toBe(scssContentHash(base));
    });

    it('does not confuse different strings', () => {
      expect(hashImportSource('')).not.toBe(hashImportSource('a'));
      expect(hashImportSource('ab')).not.toBe(hashImportSource('ba'));
    });
  });

  describe('parameter signature', () => {
    it('ignores key order', () => {
      expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
      expect(dialogueParamsSignature({ textbox: { x: 1, y: 2 } }))
        .toBe(dialogueParamsSignature({ textbox: { y: 2, x: 1 } }));
    });

    it('keeps array order and drops undefined entries', () => {
      expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
      expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    });

    it('changes when a value changes', () => {
      expect(dialogueParamsSignature({ fontSize: 32 })).not.toBe(dialogueParamsSignature({ fontSize: 33 }));
    });
  });

  describe('conflict detection', () => {
    const candidate = { sourceHash: 'hash-a', paramsSignature: 'sig-a' };

    it('reports a content match with the recorded source hash', () => {
      const conflicts = findWebGalImportConflicts(candidate, [{
        packageId: 'webgal-scss.theme',
        packageName: 'Theme',
        record: { sourceHash: 'hash-a', paramsSignature: 'other', importedAt: '2026-10-12T09:00:00.000Z' },
      }]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        packageId: 'webgal-scss.theme',
        contentMatch: true,
        paramsMatch: false,
      });
      expect(conflicts[0].importedAt).toBe('2026-10-12T09:00:00.000Z');
    });

    it('falls back to the parameters when no source hash was recorded', () => {
      const conflicts = findWebGalImportConflicts(candidate, [{
        packageId: 'webgal-scss.legacy',
        packageName: 'Legacy',
        record: { paramsSignature: 'sig-a' },
      }]);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ contentMatch: false, paramsMatch: true });
    });

    it('reports both signals when a package matches on both', () => {
      const conflicts = findWebGalImportConflicts(candidate, [{
        packageId: 'webgal-scss.both',
        packageName: 'Both',
        record: { sourceHash: 'hash-a', paramsSignature: 'sig-a' },
      }]);
      expect(conflicts[0]).toMatchObject({ contentMatch: true, paramsMatch: true });
    });

    it('stays silent for unrelated packages and for imports with no record at all', () => {
      expect(findWebGalImportConflicts(candidate, [
        { packageId: 'a', packageName: 'A', record: { sourceHash: 'other', paramsSignature: 'other' } },
        { packageId: 'b', packageName: 'B', record: null },
      ])).toEqual([]);
    });
  });
});
