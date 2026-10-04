/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IFileAccess } from '../services/io/IFileAccess';
import type { SceneCharacterIdentity } from '../services/ai-authoring/performance';
import { parseTemplatePackageManifest, type LoadedTemplatePackage } from '../services/template-package';
import { TemplatePackageCatalog } from '../services/template-package/TemplatePackageCatalog';
import {
  TemplatePerformanceProfileAuthoringService,
  type EditablePerformanceProfileTarget,
} from '../services/template-package/TemplatePerformanceProfileAuthoring';
import { TemplatePerformanceProfileEditor } from '../ui/templates/TemplatePerformanceProfileEditor';

function setup(includeSecondTemplate = false, project: {
  sceneCharacters?: readonly SceneCharacterIdentity[];
  enabledTemplateIds?: readonly string[];
} = {}, additionalPackages: readonly LoadedTemplatePackage[] = []) {
  const targets: EditablePerformanceProfileTarget[] = [{
    templateId: 'acting',
    templateName: '表演模板',
    templateVersion: '1.0.0',
    profileId: 'acting.profile',
    profileName: '表演配置',
    editable: true,
    profile: {
      schemaVersion: 1,
      id: 'acting.profile',
      name: '表演配置',
      characters: [{
        id: 'hero',
        aliases: ['主角', 'Hero'],
        motions: [{ key: 'hero/wave', description: '挥手' }, { key: 'hero/smile', description: '微笑' }],
        expressions: [{ key: 'hero/blush', description: '脸红' }],
      }, {
        id: 'friend',
        aliases: ['朋友'],
        motions: [{ key: 'friend/nod', description: '点头' }],
      }],
    },
  }];
  if (includeSecondTemplate) {
    targets.push({ ...targets[0], templateId: 'other', templateName: '另一模板' });
  }
  const service = new TemplatePerformanceProfileAuthoringService({} as IFileAccess, new TemplatePackageCatalog());
  vi.spyOn(service, 'listTargets').mockReturnValue(targets);
  const save = vi.spyOn(service, 'saveTemplate').mockImplementation(async ({ draft }) => ({
    templateId: draft.templateId,
    profileId: draft.profileId,
    draft,
  }));
  const packages: LoadedTemplatePackage[] = [...targets.map((target) => ({
    manifest: parseTemplatePackageManifest({
      manifestSchemaVersion: 2,
      template: { id: target.templateId, name: target.templateName, version: '1.0.0', compatibility: { sceneSchemaVersion: 5 } },
      performanceProfiles: [target.profile],
    }),
    source: { scope: 'user' as const, packageRoot: `/templates/${target.templateId}` },
  })), ...additionalPackages];
  render(<TemplatePerformanceProfileEditor service={service} packages={packages} revision={0} {...project} />);
  return { service, save, targets };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TemplatePerformanceProfileEditor', () => {
  it('exposes only ID and aliases for character identity and keeps template metadata internal', () => {
    setup();
    expect(screen.getByRole('textbox', { name: '角色 ID' })).toHaveValue('hero');
    expect(screen.getByRole('textbox', { name: '别名（逗号分隔）' })).toHaveValue('主角，Hero');
    expect(screen.queryByLabelText('角色名称')).not.toBeInTheDocument();
    expect(screen.queryByText('模板设置')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('模板 ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('表演配置 ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('表演配置名称')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '选择模板' })).toHaveTextContent('表演模板');
    expect(screen.getByRole('combobox', { name: '选择模板' })).not.toHaveTextContent('表演配置');
    expect(screen.queryByText('未匹配')).not.toBeInTheDocument();
    expect(screen.queryByText('匹配冲突')).not.toBeInTheDocument();
  });

  it('shows an exact ID match before alias candidates and unmatched roles in an open project', () => {
    setup(false, { enabledTemplateIds: ['acting'], sceneCharacters: [{ id: 'hero', name: '朋友' }] });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('已匹配：朋友');
    expect(screen.getByRole('button', { name: 'hero 已匹配：朋友' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'friend 未匹配' })).toBeInTheDocument();
  });

  it('updates normalized alias matches immediately as aliases and IDs are edited', () => {
    setup(false, { enabledTemplateIds: ['acting'], sceneCharacters: [{ id: 'scene.soyo', name: '長崎素世' }] });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('未匹配');
    fireEvent.change(screen.getByLabelText('别名（逗号分隔）'), { target: { value: ' 長崎素世 ' } });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('已匹配：長崎素世');
    fireEvent.change(screen.getByLabelText('别名（逗号分隔）'), { target: { value: '其他别名' } });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('未匹配');
    fireEvent.change(screen.getByLabelText('角色 ID'), { target: { value: 'scene.soyo' } });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('已匹配：長崎素世');
  });

  it('shows conflict for every template role competing for one scene character', () => {
    setup(false, { enabledTemplateIds: ['acting'], sceneCharacters: [{ id: 'scene.friend', name: '朋友' }] });
    fireEvent.change(screen.getByLabelText('别名（逗号分隔）'), { target: { value: '朋友' } });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('匹配冲突');
    expect(screen.getByRole('button', { name: 'hero 匹配冲突' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'friend 匹配冲突' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('别名（逗号分隔）'), { target: { value: '主角' } });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('未匹配');
    expect(screen.getByRole('button', { name: 'friend 已匹配：朋友' })).toBeInTheDocument();
  });

  it('shows conflict when one template role matches multiple scene characters', () => {
    setup(false, { enabledTemplateIds: ['acting'], sceneCharacters: [
      { id: 'scene.first', name: '主角' }, { id: 'scene.second', name: 'Hero' },
    ] });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('匹配冲突');
  });

  it('includes other enabled templates in conflict detection', () => {
    const other: LoadedTemplatePackage = {
      manifest: parseTemplatePackageManifest({
        manifestSchemaVersion: 2,
        template: { id: 'other', name: '另一模板', version: '1.0.0', compatibility: { sceneSchemaVersion: 5 } },
        performanceProfiles: [{ schemaVersion: 1, id: 'other.profile', name: '另一配置', characters: [{ id: 'other.hero', aliases: ['主角'] }] }],
      }),
      source: { scope: 'user', packageRoot: '/templates/other' },
    };
    setup(false, { enabledTemplateIds: ['acting', 'other'], sceneCharacters: [{ id: 'scene.hero', name: '主角' }] }, [other]);
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('匹配冲突');
  });

  it('does not claim a match for a disabled template or a project without scene characters', () => {
    setup(false, { enabledTemplateIds: [], sceneCharacters: [{ id: 'hero', name: '主角' }] });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('未匹配');
    expect(screen.getByText('项目未启用')).toBeInTheDocument();
    cleanup();
    setup(false, { enabledTemplateIds: ['acting'], sceneCharacters: [] });
    expect(screen.getByRole('status', { name: '角色匹配结果' })).toHaveTextContent('未匹配');
  });

  it('preserves both dictionaries and hidden metadata when editing filtered entries and switching tabs', async () => {
    const { save } = setup();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'smile' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'hero/smile 的 AI 描述' }), { target: { value: '温和地微笑' } });
    fireEvent.click(screen.getByRole('tab', { name: /表情/ }));
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'hero/blush 的 AI 描述' }), { target: { value: '害羞地脸红' } });

    const expressionsTab = screen.getByRole('tab', { name: /表情/ });
    fireEvent.keyDown(expressionsTab, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: /动作/ })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'hero/smile 的 AI 描述' })).toHaveValue('温和地微笑');
    expect(screen.queryByRole('textbox', { name: 'hero/blush 的 AI 描述' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toEqual(expect.objectContaining({
      originalTemplateId: 'acting',
      originalProfileId: 'acting.profile',
      draft: expect.objectContaining({
        templateId: 'acting',
        templateName: '表演模板',
        profileId: 'acting.profile',
        profileName: '表演配置',
        characters: [expect.objectContaining({
          id: 'hero',
          aliases: ['主角', 'Hero'],
          motions: [{ key: 'hero/wave', description: '挥手' }, { key: 'hero/smile', description: '温和地微笑' }],
          expressions: [{ key: 'hero/blush', description: '害羞地脸红' }],
        }), expect.objectContaining({ id: 'friend' })],
      }),
    }));
  });

  it('reveals a newly added entry despite an active search and clears search when selecting another character', () => {
    setup();
    fireEvent.click(screen.getByRole('tab', { name: /表情/ }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    fireEvent.click(screen.getByRole('button', { name: '添加表情' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getAllByRole('textbox', { name: '表情键' })).toHaveLength(2);

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hero' } });
    fireEvent.click(screen.getByRole('button', { name: 'friend' }));
    fireEvent.keyDown(screen.getByRole('tab', { name: /表情/ }), { key: 'Home' });
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '动作键' })).toHaveValue('friend/nod');
  });

  it('keeps edits when cancelling a template change through the shared selector', () => {
    setup(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.change(screen.getByRole('textbox', { name: '别名（逗号分隔）' }), { target: { value: '修改后的主角' } });
    fireEvent.click(screen.getByRole('combobox', { name: '选择模板' }));
    fireEvent.click(screen.getByRole('option', { name: /另一模板/ }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: '别名（逗号分隔）' })).toHaveValue('修改后的主角');
    expect(screen.getByRole('combobox', { name: '选择模板' })).toHaveTextContent('表演模板');
  });

  it('keeps the character selected while editing its identifier across multiple keystrokes', () => {
    setup();
    const idInput = screen.getByLabelText('角色 ID');
    fireEvent.change(idInput, { target: { value: 'hero2' } });
    fireEvent.change(idInput, { target: { value: 'hero23' } });
    expect(screen.getByLabelText('角色 ID')).toBe(idInput);
    expect(idInput).toHaveValue('hero23');
    expect(screen.getByRole('button', { name: 'hero23' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('creates a usable character without a name or exposed template metadata', async () => {
    const { save } = setup();
    fireEvent.click(screen.getByRole('button', { name: '新建模板' }));
    fireEvent.change(screen.getByRole('textbox', { name: '模板名称' }), { target: { value: '自定义表演' } });
    fireEvent.click(screen.getByRole('button', { name: '添加第一个角色' }));
    fireEvent.change(screen.getByRole('textbox', { name: '角色 ID' }), { target: { value: 'custom.hero' } });
    fireEvent.change(screen.getByRole('textbox', { name: '别名（逗号分隔）' }), { target: { value: '主角，Hero' } });
    fireEvent.click(screen.getByRole('tab', { name: /表情/ }));
    fireEvent.click(screen.getByRole('button', { name: '添加表情' }));
    fireEvent.click(screen.getByRole('button', { name: '保存模板' }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].draft.characters[0]).toEqual({
      id: 'custom.hero',
      aliases: ['主角', 'Hero'],
      expressions: [{ key: 'custom.hero/expression.1' }],
    });
  });
});
