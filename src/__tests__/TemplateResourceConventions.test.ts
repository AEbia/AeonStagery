import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { parseTemplatePackageManifest } from '../services/template-package/TemplatePackageManifest';

const base = {
  manifestSchemaVersion: 2,
  template: {
    id: 'mygo',
    name: 'MyGO',
    version: '1.0.0',
    compatibility: { sceneSchemaVersion: SCENE_SCHEMA_VERSION },
  },
};

describe('template resource conventions', () => {
  it('parses declarative manifest v2 resource conventions', () => {
    const manifest = parseTemplatePackageManifest({
      ...base,
      resourceConventions: {
        live2dModel: {
          patterns: ['live2d/{character}/models/{outfit}/{entrypoint}'],
          entrypoints: ['model.json', 'model.model3.json'],
        },
        background: { patterns: ['background/{name}.{extension}'], extensions: ['png', 'webp'] },
      },
    });
    expect(manifest.resourceConventions?.live2dModel?.entrypoints).toEqual(['model.json', 'model.model3.json']);
    expect(manifest.resourceConventions?.background?.patterns).toEqual(['background/{name}.{extension}']);
  });

  it.each([
    { background: { patterns: ['../{name}.png'] } },
    { background: { patterns: ['/absolute/{name}.png'] } },
    { background: { patterns: ['background/{target}.png'] } },
    { preset: { patterns: ['{name}.json'] } },
  ])('rejects unsafe or unsupported convention %#', (resourceConventions) => {
    expect(() => parseTemplatePackageManifest({ ...base, resourceConventions })).toThrow();
  });

  it('rejects explicit asset entries that escape the package', () => {
    expect(() => parseTemplatePackageManifest({
      ...base,
      assets: { index: [{ id: 'bad', kind: 'background', path: '../outside.png' }] },
    })).toThrow(/inside the template package/);
  });
});
