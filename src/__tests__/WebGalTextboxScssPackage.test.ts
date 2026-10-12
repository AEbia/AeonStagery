import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import {
  createLoadedTemplatePackage,
  createTemplatePackageView,
  parseTemplatePackageManifest,
} from '../services/template-package';
import {
  buildWebGalTextboxTemplatePackage,
  describeWebGalTemplatePackageFiles,
  type WebGalTemplatePackageBuild,
  type WebGalTemplatePackageInput,
} from '../services/import/webgal/WebGalTextboxScssPackage';

/**
 * A synthetic template that exercises the paths a real WebGAL theme uses:
 * a container `transform: scale()`, a `%` body font size, an outline layer, a
 * `background-clip: text` fill, a gradient nameplate and a corner ornament.
 */
const FIXTURE = `
.TextBox_main {
  position: absolute;
  left: 120px;
  right: 120px;
  bottom: 60px;
  height: 300px;
  padding: 40px;
  font-size: 40px;
  transform: scale(0.5);
  align-items: flex-start;
}
.text { font-size: 240%; line-height: 1.4; }
.TextBox_Background {
  background: rgba(255, 255, 255, 0.8);
  border: 2px solid black;
  border-radius: 24px;
  box-shadow: 0 6px 20px rgba(190, 190, 190, 0.8);
}
.TextBox_Background::after {
  width: 105px; height: 105px; right: 8px; bottom: -5px; opacity: 0.4;
  background-image: url('assets/textbox-meteor.svg');
}
.outer { color: transparent; background: #123456; background-clip: text; }
.inner { -webkit-text-stroke: 4px white; text-shadow: 0 0 12px rgba(0,0,0,.9); }
.TextBox_showName {
  left: 24px;
  top: -72px;
  min-width: 10em;
  padding-left: 1.5em;
  font-size: 100%;
}
.outerName { color: #FFFFFFCC; }
.TextBox_ShowName_Background {
  background: linear-gradient(180deg, #ff9ec4, #ff3b72);
  border-radius: 9999px;
}
.innerName { -webkit-text-stroke: 6px #ff3b72; }
`;

const DECO = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="#f0f"/></svg>';
const FONT = '/templates/fixture/assets/FixtureSans.ttf';

function build(overrides: Partial<WebGalTemplatePackageInput> = {}): WebGalTemplatePackageBuild {
  return buildWebGalTextboxTemplatePackage({
    scss: FIXTURE,
    templateId: 'webgal-scss.fixture',
    templateName: 'Fixture Theme',
    sourceName: 'textbox.scss',
    font: { family: 'Fixture Sans', sourcePath: FONT },
    decoSources: { textbox: DECO },
    ...overrides,
  });
}

/** Files whose content is written as text rather than copied. */
function textFiles(result: WebGalTemplatePackageBuild): Array<{ relativePath: string; contents: string }> {
  return result.files.filter(
    (file): file is { relativePath: string; contents: string } => file.contents !== undefined,
  );
}

describe('buildWebGalTextboxTemplatePackage', () => {
  it('emits a manifest plus the artwork and the template font', () => {
    const result = build();

    const listed = describeWebGalTemplatePackageFiles(result);
    expect(listed).toHaveLength(4);
    expect(listed).toContain('manifest.v2.json');
    expect(listed).toContain('assets/fonts/FixtureSans.ttf (copied)');
    expect(listed.find((entry) => entry.includes('textbox-')))
      .toMatch(/^assets\/ui\/dialogue\/webgal\/textbox-[\w-]+\.svg$/);
    expect(listed.find((entry) => entry.includes('namebox-')))
      .toMatch(/^assets\/ui\/dialogue\/webgal\/namebox-[\w-]+\.svg$/);

    const font = result.files.find((file) => file.relativePath.endsWith('.ttf'));
    expect(font?.contents).toBeUndefined();
    expect(font?.sourcePath).toBe(FONT);

    const manifestFile = result.files.find((file) => file.relativePath === 'manifest.v2.json');
    expect(manifestFile?.sourcePath).toBeUndefined();
    expect(JSON.parse(manifestFile!.contents!)).toEqual(result.manifest);
  });

  it('points the parameters at the files it actually emits', () => {
    const result = build();
    const emitted = new Set(result.files.map((file) => file.relativePath));
    const params = result.style.params as Record<string, any>;

    // The engine resolves `image` and `fontFile` against `assets.root`, so a
    // mismatch here is an ENOENT the moment the style is applied.
    expect(result.manifest.assets).toEqual({ root: 'assets' });
    for (const slot of ['textbox', 'namebox'] as const) {
      expect(emitted.has(`assets/${params[slot].image}`)).toBe(true);
    }
    for (const slot of ['text', 'speaker'] as const) {
      expect(emitted.has(`assets/${params[slot].fontFile}`)).toBe(true);
    }
  });

  it('omits the font when the template ships none', () => {
    const result = build({ font: null });
    const params = result.style.params as Record<string, any>;

    expect(result.files.some((file) => file.relativePath.endsWith('.ttf'))).toBe(false);
    expect(params.text.fontFile).toBeUndefined();
    expect(params.speaker.fontFile).toBeUndefined();
  });

  it('defaults the dialogue style id to the package id so imports stay distinguishable', () => {
    const result = build();
    expect(result.style.id).toBe('webgal-scss.fixture');
    expect(result.style.name).toBe('Fixture Theme');
    expect(result.style.renderer).toBe('image-dialogue-v1');

    const overridden = build({ styleId: 'my-style', styleName: 'My Style' });
    expect(overridden.style.id).toBe('my-style');
    expect(overridden.style.name).toBe('My Style');
  });

  it('rejects an empty template id', () => {
    expect(() => build({ templateId: '   ' })).toThrow(/templateId/);
  });

  it('produces a manifest the engine accepts', () => {
    const result = build();

    // Re-parsing is what the builder does internally; keep asserting it here so
    // a regression names the offending field instead of surfacing as "the
    // import silently did nothing".
    expect(() => parseTemplatePackageManifest(result.manifest)).not.toThrow();
    expect(result.manifest.manifestSchemaVersion).toBe(2);
    expect(result.manifest.template.compatibility).toEqual({ sceneSchemaVersion: SCENE_SCHEMA_VERSION });
    expect(result.manifest.template.category).toBe('dialogue');
    expect(result.manifest.template.description).toContain('Fixture Theme');
  });

  it('carries the translated geometry, typography and outline', () => {
    const params = build().style.params as Record<string, any>;

    expect(params.textbox).toMatchObject({ x: 525, y: 866, width: 870, height: 116, opacity: 1 });
    expect(params.namebox).toMatchObject({ x: 534, y: 839, width: 300, minHeight: 57 });
    expect(params.text).toMatchObject({ fontSize: 15, lineHeight: 21, align: 'left', color: '#123456' });
    // `-webkit-text-stroke: 4px white` — the named colour has to resolve, the
    // width is a stage pixel and the container scale applies on top.
    expect(params.text).toMatchObject({ strokeColor: '#FFFFFF', strokeWidth: 2 });
    // `0 0 12px` has no direction, so distance stays 0.
    expect(params.text).toMatchObject({ dropShadow: true, dropShadowBlur: 5, dropShadowDistance: 0 });
    expect(params.speaker).toMatchObject({
      fontSize: 30,
      fontWeight: '400',
      align: 'left',
      strokeColor: '#FF3B72',
      strokeWidth: 5,
    });
  });

  it('inlines the referenced ornament into the panel artwork', () => {
    const svg = textFiles(build()).find((file) => file.relativePath.includes('textbox-'))!.contents;
    expect(svg).toContain('#f0f');
    // Templates rely on the parent's `overflow: hidden` for negative offsets.
    expect(svg).toContain('clipPath');

    const withoutDecoration = textFiles(build({ decoSources: null }))
      .find((file) => file.relativePath.includes('textbox-'))!.contents;
    expect(withoutDecoration).not.toContain('#f0f');
  });

  it('explains every approximation it made', () => {
    const { notes } = build();
    expect(notes.length).toBeGreaterThan(5);
    expect(notes.join('\n')).toContain('scale(0.5)');
  });

  it('shows up in the merged style list of a package view', () => {
    const result = build();
    const view = createTemplatePackageView([
      createLoadedTemplatePackage(result.manifest, {
        scope: 'project',
        packageRoot: '/tmp/webgal-scss.fixture',
      }),
    ]);

    expect(view.dialogueStyles.map((style) => style.id)).toEqual(['webgal-scss.fixture']);
  });

  it('would displace another package that reused the same style id', () => {
    // Style ids are de-duplicated across packages, which is why the builder
    // derives them from the package id: two templates both naming their style
    // after `textbox.scss` would fight over one entry in the list.
    const first = build();
    const second = build({ templateId: 'webgal-scss.other', styleId: 'webgal-scss.fixture' });
    const view = createTemplatePackageView([
      createLoadedTemplatePackage(first.manifest, { scope: 'project', packageRoot: '/tmp/a' }),
      createLoadedTemplatePackage(second.manifest, { scope: 'project', packageRoot: '/tmp/b' }),
    ]);

    expect(view.dialogueStyles.filter((style) => style.id === 'webgal-scss.fixture')).toHaveLength(1);
  });

  it('explains why unknown parameter keys must be caught before writing', () => {
    const result = build();
    const tampered = JSON.parse(JSON.stringify(result.manifest));
    tampered.dialogueStyles[0].params.speaker.nameGlow = true;

    // The engine rejects the whole package over a single stray key. The builder
    // runs this same validation so the failure happens at build time.
    expect(() => parseTemplatePackageManifest(tampered)).toThrow(/Unknown field/);
    expect(() => parseTemplatePackageManifest(result.manifest)).not.toThrow();
  });

  it('keeps asset paths inside the package', () => {
    for (const file of build().files) {
      expect(file.relativePath.startsWith('/')).toBe(false);
      expect(file.relativePath).not.toMatch(/^[A-Za-z]:/);
      expect(file.relativePath.split('/')).not.toContain('..');
    }
  });
});
