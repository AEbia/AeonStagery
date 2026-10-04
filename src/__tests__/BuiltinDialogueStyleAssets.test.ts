import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import { SEMANTIC_BUILTIN_TEMPLATE_PACKAGE } from '../services/template-package/BuiltinTemplatePackage';
import { createTemplatePackageView } from '../services/template-package';
import type { DialogueImagePresentation } from '../api/types/semantic-scene';

describe('builtin image dialogue assets', () => {
  it('offers both styles through the default package and ships every referenced asset', () => {
    const builtin = SEMANTIC_BUILTIN_TEMPLATE_PACKAGE;
    const view = createTemplatePackageView([builtin], { enabledTemplateIds: ['aeonstagery.default'] });
    expect(packageJson.build.files).toContain(`${builtin.source.packageRoot}/assets/**/*`);
    for (const [id, name] of [['pink-nameplate', '粉色名牌'], ['immersive-subtitle', '沉浸字幕']]) {
      const style = view.dialogueStyles.find((candidate) => candidate.id === id);
      expect(style?.name).toBe(name);
      expect(style?.renderer).toBe('image-dialogue-v1');
      expect(JSON.stringify(style)).not.toMatch(/mygo/i);
      const params = style!.params! as unknown as DialogueImagePresentation;
      for (const reference of [params.textbox.image, params.namebox!.image, params.text.fontFile!]) {
        const assetPath = resolve(builtin.source.packageRoot, builtin.manifest.assets?.root ?? 'assets', reference);
        expect(existsSync(assetPath), assetPath).toBe(true);
        if (reference.endsWith('.svg')) expect(readFileSync(assetPath, 'utf8')).not.toMatch(/mygo/i);
      }
    }
  });
});
