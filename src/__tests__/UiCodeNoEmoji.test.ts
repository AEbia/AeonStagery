import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(__dirname, '..');
const UI_ROOT = path.join(SRC_ROOT, 'ui');
const ROOT_UI_FILE_PATTERN = /\.(tsx|css)$/;
const UI_SOURCE_PATTERN = /\.(ts|tsx|css)$/;
// Matches Unicode emoji/pictographic code points (e.g. U+1F31F, U+26A1),
// regional-indicator flag emoji (U+1F1E6..U+1F1FF), and keycap emoji.
const EMOJI_PATTERN = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[#*0-9]\uFE0F?\u20E3/u;

function collectUiSourceFiles(): string[] {
  const files: string[] = [];

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (UI_SOURCE_PATTERN.test(entry.name)) {
        files.push(fullPath);
      }
    }
  };

  walk(UI_ROOT);
  walk(path.join(SRC_ROOT, 'styles'));

  // Root-level UI entry files: App.tsx, AgentWindow.tsx, WorkspaceToolsWindow.tsx,
  // main.tsx and index.css are also UI code even though they live outside src/ui.
  if (fs.existsSync(SRC_ROOT)) {
    for (const entry of fs.readdirSync(SRC_ROOT, { withFileTypes: true })) {
      if (entry.isFile() && ROOT_UI_FILE_PATTERN.test(entry.name)) {
        files.push(path.join(SRC_ROOT, entry.name));
      }
    }
  }

  return [...new Set(files)];
}

describe('UI code must not contain emoji', () => {
  const files = collectUiSourceFiles().sort();

  it.each(files.map((file) => [path.relative(SRC_ROOT, file).replace(/\\/g, '/'), file] as const))(
    'has no emoji in %s',
    (_relativePath, file) => {
      const content = fs.readFileSync(file, 'utf8');
      const matches = content.match(EMOJI_PATTERN);
      expect(matches, 'UI code must not contain emoji').toBeNull();
    },
  );
});
