/**
 * PixiJS 8 migration guard.
 *
 * Static typecheck cannot protect files that opt out of it (@ts-nocheck) or
 * call sites that go through v8's deprecated runtime shims — several v7 idioms
 * survive compilation and only break (or silently render nothing) at runtime:
 *
 * - `new ObservablePoint(cb, target, x, y)` → TypeError on mutation in v8
 *   (v8 requires an observer object: `new ObservablePoint({ _onUpdate }, x, y)`).
 * - `lineStyle()` + path commands without a trailing `endFill()`/`.stroke()`
 *   → v7 flushed strokes implicitly; v8 buffers paths until fill()/stroke(),
 *   so the geometry silently never renders.
 * - `app.view`, `PIXI.TextMetrics`, `new PIXI.Text(str, style)` → removed in v8.
 * - v7 package imports (`pixi-live2d-display`, `@pixi/unsafe-eval`) → the
 *   replacement runtime is `untitled-pixi-live2d-engine` + `pixi.js/unsafe-eval`.
 * - `renderer.state.reset()` / `renderer.texture.reset()` / `renderer.reset()` /
 *   `shader.reset()` → v8 renamed these to `resetState()` (renderer-level, plus a
 *   per-system `resetState()` reached through the `resetState` runner). The v7
 *   names are simply absent on a real WebGL renderer, so a direct call throws
 *   `TypeError: … reset is not a function` and an optional-chained one silently
 *   stops resetting GL state that Live2D Cubism 2.1 dirties.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ENGINE_ROOT = path.resolve(__dirname, '..', 'engine');
const SRC_ROOT = path.resolve(__dirname, '..');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out comments so rules only ever see code. Migration notes legitimately
 * name the v7 APIs they forbid, so matching raw text would report the prose as
 * an offender. Line structure is preserved to keep reported line numbers true.
 */
function stripComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, block =>
    block.replace(/[^\n]/g, ' '),
  );
  // `//` inside a string (mostly `https://…`) is not a comment start.
  return withoutBlock.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Rule {
  name: string;
  pattern: RegExp;
  hint: string;
  /** Optional extra condition: when present and it matches the same file, the file is compliant. */
  allowlist?: RegExp;
}

const RULES: Rule[] = [
  {
    name: 'v7 pixi-live2d-display import',
    pattern: /(?:from|import\()\s*['"]pixi-live2d-display/,
    hint: "use 'untitled-pixi-live2d-engine' (and '/cubism-legacy') instead.",
  },
  {
    name: '@pixi/unsafe-eval import',
    pattern: /['"]@pixi\/unsafe-eval['"]/,
    hint: "use 'pixi.js/unsafe-eval' instead.",
  },
  {
    name: 'v7-style ObservablePoint constructor',
    pattern: /new (?:PIXI\.)?ObservablePoint\(\s*(?!\{)/,
    hint: 'v8 requires the observer-object form: new ObservablePoint({ _onUpdate: ... }, x, y).',
  },
  {
    name: 'v7 PIXI.TextMetrics',
    pattern: /PIXI\.TextMetrics\b/,
    hint: 'v8 renamed the canvas metrics class to PIXI.CanvasTextMetrics.',
  },
  {
    name: 'v7 app.view accessor',
    pattern: /\b(?:app|this\.app|_app)\.view\b/,
    hint: 'v8 exposes the canvas as app.canvas.',
  },
  {
    name: 'v7 positional Text constructor',
    pattern: /new (?:PIXI\.)?Text\(\s*['"`]/,
    hint: 'v8 takes an options object: new Text({ text, style }).',
  },
  {
    name: 'deprecated positional RGBSplitFilter constructor',
    pattern: /new RGBSplitFilter\(\s*\[/,
    hint: 'pixi-filters v6 takes { red, green, blue } options; the positional form logs a deprecation warning.',
  },
  {
    name: 'positional TilingSprite constructor',
    pattern: /new (?:PIXI\.)?TilingSprite\(\s*(?!\{)/,
    hint: 'v8 takes { texture, width, height }; the positional form logs a deprecation warning.',
  },
  {
    // v7: AbstractRenderer.reset(). v8: resetState(), which emits the
    // resetState runner over every GL system. `reset?.()` would compile and
    // typecheck against an `any` renderer while doing nothing at runtime.
    name: 'v7 renderer-level reset()',
    pattern: /\brenderer\s*\??\.\s*reset\s*[?(]/,
    hint: 'v8 renamed the renderer-level seam to resetState(); the v7 reset() does not exist on a WebGL renderer.',
  },
  {
    // v7: state.reset() / texture.reset() / shader.reset(). v8: each GL system
    // exposes resetState() instead — reached through renderer.resetState().
    name: 'v7 per-system reset() (state/texture/shader/…)',
    pattern: /\b(?:state|texture|shader|geometry|buffer|maskEffect|renderTarget|framebuffer|batch)\s*\??\.\s*reset\s*[?(]/,
    hint: 'v8 GL systems expose resetState(); call renderer.resetState() (or the system\'s resetState()) — a v7 reset() either throws or is silently skipped by `?.`.',
  },
  {
    // v7 kept batching and render-target/viewport state on the renderer itself.
    // v8 moved them to renderPipes.batch (BatcherPipe/`_elements`) and
    // renderTarget (GlRenderTargetSystem). Neither name exists on a v8
    // renderer, so `renderer?.batch?.…` quietly reads undefined and the salvage
    // code around it becomes unreachable.
    name: 'v7 renderer-level batch/framebuffer system',
    pattern: /\brenderer\s*\??\.\s*(?:batch|framebuffer)\b/,
    hint: 'v8 has no renderer.batch / renderer.framebuffer — use renderer.renderPipes.batch and renderer.renderTarget (viewport + resetState()).',
  },
  {
    // v7 exposed the GL context uid on the renderer, which is why the Cubism 2
    // bake guard could swap it for a dense slot. v8 keeps CONTEXT_UID as a
    // protected member of the context/GPU systems only; writing
    // `renderer.CONTEXT_UID` creates a property nothing reads.
    name: 'v7 renderer.CONTEXT_UID',
    pattern: /\brenderer\s*\??\.\s*CONTEXT_UID\b/,
    hint: 'v8 has no renderer-level CONTEXT_UID (it is a protected member of GlContextSystem); the bake slot machinery built on it is dead code.',
  },
  {
    // v7 drew a child through Container._render(renderer). v8 removed
    // _render()/render() from Container entirely — an engine guard that wraps
    // them never runs, and because the wrap was conditional the failure was
    // silent. Live2D v8 draws through the per-instance renderLive2D(renderer).
    name: 'v7 Container draw boundary (_render)',
    pattern: /\b\w*[Mm]odel\w*\s*\??\.\s*_render\b/,
    hint: 'v8 Container has no _render(); anchor Cubism 2 GL guards on renderLive2D via findRenderGuardAnchor()/wrapRenderBoundary().',
  },
  {
    // v8's filters getter returns Object.freeze(value.slice(0)) (effectsMixin).
    // Mutating it in place throws `Cannot delete property '0' of [object Array]`
    // once per frame on the fade-out path, aborting the timeline transform sync
    // and stranding the AlphaFilter on the container. Add/remove must go
    // through the setter with a fresh array.
    name: 'v7 in-place filters array mutation',
    pattern: /\(\s*[\w.]+\.filters\s+as\s+[^\)]+\)\s*\.\s*(?:push|splice|pop|shift|unshift)\s*\(/,
    hint: 'v8 freezes the filters getter — assign through container.filters = [...current, f] / .filter(...) (null when empty) instead of in-place push/splice.',
  },
  {
    name: 'unflushed v7 stroke pattern',
    pattern: /\.lineStyle\(/,
    allowlist: /\.(?:endFill|stroke)\s*\(/,
    hint: 'v8 Graphics only renders a path on fill()/stroke(); lineStyle without a later endFill()/.stroke() silently draws nothing.',
  },
];

const FILES = [
  ...listSourceFiles(ENGINE_ROOT),
  path.join(SRC_ROOT, 'main.tsx'),
].filter(file => fs.existsSync(file));

describe('PixiJS 8 migration guard', () => {
  it('scans the engine sources', () => {
    // Sanity: if the scan silently finds nothing the guard is dead code.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('flags the v7 reset seams it exists to catch, and not their v8 names', () => {
    // Without this, a mistyped pattern would keep the suite green while the
    // rule quietly stopped protecting anything.
    const v7Shapes = [
      'app.renderer.state.reset();',
      'app.renderer.texture.reset();',
      'renderer.reset?.();',
      'renderer?.shader?.reset?.();',
      'filterManager?.renderer?.shader?.reset?.();',
    ];
    const resetRules = RULES.filter(rule => /reset\(\)/.test(rule.name));
    expect(resetRules).toHaveLength(2);
    for (const shape of v7Shapes) {
      expect(resetRules.some(rule => rule.pattern.test(shape)), shape).toBe(true);
    }
    // The v8 replacements must not trip the guard.
    for (const v8Shape of [
      'app.renderer.resetState();',
      'renderer.resetState?.();',
      'renderer?.shader?.resetState?.();',
      'this.colorFilter.reset();',
      'lighting.reset();',
    ]) {
      expect(resetRules.some(rule => rule.pattern.test(v8Shape)), v8Shape).toBe(false);
    }
  });

  it('flags the v7 renderer systems and draw boundary it exists to catch', () => {
    // Same anti-rot check as the reset rules: a mistyped pattern would keep the
    // suite green while the rule quietly stopped protecting anything.
    const caseRules = RULES.filter(rule => /batch\/framebuffer|CONTEXT_UID|draw boundary/.test(rule.name));
    expect(caseRules).toHaveLength(3);

    const v7Shapes: Record<string, string[]> = {
      'v7 renderer-level batch/framebuffer system': [
        'renderer.batch.currentRenderer._bufferedTextures',
        'const textures = renderer?.framebuffer.viewport;',
      ],
      'v7 renderer.CONTEXT_UID': [
        'renderer.CONTEXT_UID = bakeContextUid;',
        'const uid = renderer?.CONTEXT_UID;',
      ],
      'v7 Container draw boundary (_render)': [
        'const originalRender = model._render.bind(model);',
        'model._render = (renderer) => {};',
      ],
    };
    const v8Shapes = [
      'renderer.renderPipes.batch.break(instructionSet);',
      'renderer.renderTarget.viewport.x;',
      'renderer?.renderTarget?.resetState?.();',
      'model.renderLive2D(renderer);',
      'findRenderGuardAnchor(model);',
    ];

    for (const rule of caseRules) {
      for (const shape of v7Shapes[rule.name]) {
        expect(rule.pattern.test(shape), shape).toBe(true);
      }
    }
    for (const shape of v8Shapes) {
      for (const rule of caseRules) {
        expect(rule.pattern.test(shape), `${shape} vs ${rule.name}`).toBe(false);
      }
    }
  });

  it('flags v7 in-place filters mutation but not the v8 setter idiom', () => {
    const rule = RULES.find(r => r.name === 'v7 in-place filters array mutation');
    expect(rule).toBeDefined();

    const v7Shapes = [
      '(container.filters as any[]).push(alphaFilter);',
      '(container.filters as any[]).splice(idx, 1);',
      '(this.model.filters as Filter[]).pop();',
    ];
    for (const shape of v7Shapes) {
      expect(rule!.pattern.test(shape), shape).toBe(true);
    }
    // The v8 replacements must not trip the guard.
    const v8Shapes = [
      'container.filters = [...currentFilters, alphaFilter];',
      'const idx = container.filters.indexOf(alphaFilter);',
      'const remaining = currentFilters.filter((f: any) => f !== alphaFilter);',
      'container.filters = remaining.length > 0 ? remaining : null;',
    ];
    for (const shape of v8Shapes) {
      expect(rule!.pattern.test(shape), shape).toBe(false);
    }
  });

  it('ignores migration notes that name the forbidden v7 APIs', () => {
    const documented = [
      '  // v7 called this renderer.reset(); v8 renamed it to resetState().',
      '  /* The old state.reset() / texture.reset() pair is gone. */',
      '  /* v7 wrapped model._render(); v8 draws through renderLive2D. */',
      '  /* renderer.CONTEXT_UID and renderer.batch do not exist in v8. */',
      "  const url = 'https://cdn.example.com/live2d.js'; // still a URL, not a comment start",
    ].join('\n');
    const stripped = stripComments(documented);
    expect(stripped).not.toMatch(/renderer\s*\??\.\s*reset/);
    expect(stripped).not.toMatch(/\brenderer\s*\??\.\s*CONTEXT_UID\b/);
    expect(stripped).not.toMatch(/\bmodel\w*\s*\??\.\s*_render\b/);
    expect(stripped).toContain('https://cdn.example.com/live2d.js');
  });

  for (const rule of RULES) {
    it(`no ${rule.name}`, () => {
      const offenders: string[] = [];
      for (const file of FILES) {
        const source = stripComments(fs.readFileSync(file, 'utf8'));
        if (!rule.pattern.test(source)) continue;
        if (rule.allowlist && rule.allowlist.test(source)) continue;
        const line = source
          .split('\n')
          .findIndex(line => rule.pattern.test(line));
        offenders.push(`${path.relative(SRC_ROOT, file)}:${line + 1} — ${rule.hint}`);
      }
      expect(offenders, `v7 idiom reintroduced:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
