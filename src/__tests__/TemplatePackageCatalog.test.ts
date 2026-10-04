import { describe, expect, it, vi } from 'vitest';
import { TemplatePackageCatalog, type LoadedTemplatePackage } from '../services/template-package';

function makePackage(id: string): LoadedTemplatePackage {
  return {
    manifest: {
      manifestSchemaVersion: 2,
      template: { id, name: `Template ${id}`, version: '1.0.0' },
      defaults: { dialogueStyleId: `${id}:dialogue` },
      characterPresets: [{ id: `${id}:character`, name: 'Character', variants: [{ id: 'default', name: 'Default', model: 'figure/model.wmdl' }] }],
      dialogueStyles: [{ id: `${id}:dialogue`, name: 'Dialogue', renderer: 'default' }],
      lightingPresets: [{ id: `${id}:light`, name: 'Light' }],
      cameraPresets: [{ id: `${id}:camera` }],
    },
    source: { scope: 'builtin', packageRoot: `templates/${id}` },
  };
}

function makePerformancePackage(id: string, scope: LoadedTemplatePackage['source']['scope'], name: string): LoadedTemplatePackage {
  return {
    manifest: {
      manifestSchemaVersion: 2,
      template: { id, name, version: '1.0.0' },
      performanceProfiles: [{
        schemaVersion: 1,
        id: `${id}.profile`,
        name: `${name} Profile`,
        characters: [],
      }],
    },
    source: { scope, packageRoot: `/${scope}/${id}` },
  };
}

describe('TemplatePackageCatalog', () => {
  it('publishes immutable package lists and UI summaries without legacy authoring services', () => {
    const first = makePackage('first');
    const catalog = new TemplatePackageCatalog([first]);
    const snapshot = catalog.getPackages();
    expect(snapshot).toEqual([first]);
    expect(catalog.getSummaries()).toEqual([
      expect.objectContaining({
        id: 'first',
        defaults: { dialogueStyleId: 'first:dialogue' },
        characterPresets: [expect.objectContaining({ variantCount: 1 })],
        lightingPresets: [{ id: 'first:light', name: 'Light' }],
        cameraPresets: [{ id: 'first:camera', name: 'first:camera' }],
      }),
    ]);
  });

  it('notifies subscribers when discovery replaces the package set', () => {
    const catalog = new TemplatePackageCatalog();
    const listener = vi.fn();
    const unsubscribe = catalog.subscribe(listener);
    catalog.setPackages([makePackage('next')]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    catalog.setPackages([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('publishes one effective summary when an authored package overlays the same template id', () => {
    const authored = makePerformancePackage('acting', 'user', 'Edited Acting');
    const bundled = makePerformancePackage('acting', 'builtin', 'Bundled Acting');
    const catalog = new TemplatePackageCatalog([bundled, authored]);

    expect(catalog.getSummaries()).toEqual([
      expect.objectContaining({ id: 'acting', name: 'Edited Acting' }),
    ]);
  });

  it('can rescan packages through its configured refresh handler', async () => {
    const catalog = new TemplatePackageCatalog([makePackage('old')]);
    const refresh = vi.fn(async () => {
      catalog.setPackages([makePackage('fresh')]);
    });
    catalog.setRefreshHandler(refresh);

    await catalog.refresh();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(catalog.getPackages()[0]?.manifest.template.id).toBe('fresh');
  });

  it('reports collisions between canonical template ids and aliases', () => {
    const acting = makePackage('acting');
    acting.manifest.template.aliases = ['legacy.acting'];
    const collision = makePackage('legacy.acting');
    const catalog = new TemplatePackageCatalog([acting, collision]);

    expect(catalog.getIdentityIssues()).toEqual([
      expect.stringContaining('legacy.acting'),
    ]);
  });
});
