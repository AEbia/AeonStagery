import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(...segments: string[]): string {
  return readFileSync(resolve(process.cwd(), ...segments), 'utf8');
}

function extractThemeBlock(css: string, theme: 'dark'): string {
  const match = css.match(new RegExp(`\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`));
  expect(match, `Expected to find [data-theme="${theme}"] block`).not.toBeNull();
  return match![1];
}

describe('theme palettes', () => {
  it('uses a calm non-amber palette for dark mode', () => {
    const css = readSource('src', 'styles', 'foundation.css');
    const darkTheme = extractThemeBlock(css, 'dark');

    expect(darkTheme).toContain('--bg-primary: #11131a;');
    expect(darkTheme).toContain('--bg-secondary: rgba(24, 25, 34, 0.92);');
    expect(darkTheme).toContain('--text-primary: #f1eee9;');
    expect(darkTheme).toContain('--accent-primary: #d88c7a;');
    expect(darkTheme).not.toContain('--accent-primary: #f59e0b;');
    expect(darkTheme).not.toContain('--accent-secondary: #fbbf24;');
  });

  it('removes the retired pink-brown palette', () => {
    const css = readSource('src', 'styles', 'foundation.css');
    expect(css).not.toContain('[data-theme="pink"]');
  });

  it('keeps Monaco editor colors aligned with refreshed themes', () => {
    const source = readSource('src', 'ui', 'monaco', 'monacoRuntime.ts');

    expect(source).not.toContain('pink');
    expect(source).toContain("bg = '#1a1b24';");
    expect(source).toContain("text = '#f1eee9';");
    expect(source).toContain("cursor = '#d88c7a';");
  });

  it('uses hex alpha colors for Monaco line highlights so invalid theme colors do not fall back to red', () => {
    const source = readSource('src', 'ui', 'monaco', 'monacoRuntime.ts');

    expect(source).not.toContain("lineHighlight = 'rgba(");
    expect(source).not.toContain("lineHighlight = '#3f2d2912';");
    expect(source).toContain("lineHighlight = '#ffffff12';");
  });

  it('removes the retired theme from settings', () => {
    const source = readSource('src', 'ui', 'SettingsDialog.tsx');

    expect(source).not.toContain('粉棕');
    expect(source).not.toContain("value: 'pink'");
  });
});
