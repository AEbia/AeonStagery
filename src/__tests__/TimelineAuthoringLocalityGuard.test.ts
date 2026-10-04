import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const AUTHORING_ROOT = path.join(ROOT, 'services', 'timeline-authoring');

function collectAuthoringFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectAuthoringFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('timeline authoring locality guard', () => {
  const authoringFiles = collectAuthoringFiles(AUTHORING_ROOT);
  const forbiddenUiPolicyImports = [
    /from ['"].*ui\/timeline\/TimelineConstants['"]/,
    /from ['"].*ui\/StatementTemplates['"]/,
  ];

  for (const fullPath of authoringFiles) {
    const relativeFile = path.relative(ROOT, fullPath).replace(/\\/g, '/');

    it(`keeps authoring policy local in ${relativeFile}`, () => {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const pattern of forbiddenUiPolicyImports) {
        expect(content, `${relativeFile} should not import UI-owned policy definitions`).not.toMatch(pattern);
      }
    });
  }
});
