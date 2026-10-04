/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VoiceWorkbench } from '../ui/voice/VoiceWorkbench';

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

async function chooseFormSelect(name: string, optionName: string) {
  const combobox = screen.getByRole('combobox', { name });
  await waitFor(() => {
    if (combobox.getAttribute('aria-expanded') !== 'true') fireEvent.click(combobox);
    const listbox = document.getElementById(combobox.getAttribute('aria-controls') || '');
    expect(listbox).toBeTruthy();
    expect(within(listbox!).getByRole('option', { name: optionName })).toBeTruthy();
  });
  const listbox = document.getElementById(combobox.getAttribute('aria-controls') || '');
  fireEvent.click(within(listbox!).getByRole('option', { name: optionName }));
  return combobox;
}

describe('VoiceWorkbench v2Pro inference controls', () => {
  it('focuses the target text first and restores the opener when closed', async () => {
    const service = {
      listPresets: vi.fn(async () => ({ success: true, library: { schemaVersion: 1, presets: [] } })),
      scanCatalog: vi.fn(async () => ({ models: [], references: [], issues: [], truncated: false })),
      discardSession: vi.fn(async () => ({ success: true })),
    } as any;
    const openerView = render(<button type="button">打开语音工作台</button>);
    const opener = screen.getByRole('button', { name: '打开语音工作台' });
    opener.focus();
    const workbenchView = render(
      <VoiceWorkbench
        isOpen
        context={{ mode: 'free' }}
        project={null}
        config={{ apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' }}
        service={service}
        onClose={() => undefined}
      />,
    );

    const targetText = screen.getByRole('textbox', { name: '目标文本' });
    await waitFor(() => expect(document.activeElement).toBe(targetText));
    workbenchView.rerender(
      <VoiceWorkbench
        isOpen={false}
        context={{ mode: 'free' }}
        project={null}
        config={{ apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' }}
        service={service}
        onClose={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(opener);
    openerView.unmount();
  });

  it('passes auxiliary references and complete inference defaults to candidate generation', async () => {
    const generateCandidate = vi.fn(async () => ({ success: false, error: 'expected test stop' }));
    const service = {
      listPresets: vi.fn(async () => ({ success: true, library: { schemaVersion: 1, presets: [] } })),
      scanCatalog: vi.fn(async () => ({
        models: [
          { kind: 'gpt', fileName: 'voice.ckpt', absolutePath: 'D:/models/voice.ckpt', sourceRoot: 'D:/models' },
          { kind: 'sovits', fileName: 'voice.pth', absolutePath: 'D:/models/voice.pth', sourceRoot: 'D:/models' },
        ],
        references: [
          { fileName: 'main.wav', absolutePath: 'D:/refs/main.wav', sourceRoot: 'D:/refs', pathTags: [], transcriptTrusted: false },
          { fileName: 'aux.wav', absolutePath: 'D:/refs/aux.wav', sourceRoot: 'D:/refs', pathTags: [], transcriptTrusted: false },
        ],
        issues: [], truncated: false,
      })),
      generateCandidate,
      discardSession: vi.fn(async () => ({ success: true })),
    } as any;

    const { container } = render(
      <VoiceWorkbench
        isOpen
        context={{ mode: 'free' }}
        project={null}
        config={{ apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' }}
        service={service}
        onClose={() => undefined}
      />,
    );

    await chooseFormSelect('GPT 模型', 'voice.ckpt');
    await chooseFormSelect('SoVITS 模型', 'voice.pth');
    await chooseFormSelect('参考音频', 'main');
    await chooseFormSelect('添加辅助参考音频', 'aux');
    fireEvent.click(screen.getByRole('checkbox', { name: '无参考文本模式' }));
    const textareas = container.querySelectorAll('textarea');
    fireEvent.change(textareas[1], { target: { value: '需要合成的文本' } });

    fireEvent.click(screen.getByRole('button', { name: '生成候选' }));

    await waitFor(() => expect(generateCandidate).toHaveBeenCalledTimes(1));
    expect(generateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      referenceAudioPath: 'D:/refs/main.wav',
      auxiliaryReferenceAudioPaths: ['D:/refs/aux.wav'],
      promptText: '',
      promptLang: 'all_ja',
      options: expect.objectContaining({
        textLang: 'all_ja',
        batchSize: 1,
        batchThreshold: 0.75,
        splitBucket: true,
        fragmentInterval: 0.3,
        parallelInfer: true,
        seed: -1,
      }),
    }));
  });

  it('groups references by directory and only populates prompt text from the primary reference', async () => {
    const service = {
      listPresets: vi.fn(async () => ({ success: true, library: { schemaVersion: 1, presets: [] } })),
      scanCatalog: vi.fn(async () => ({
        models: [],
        references: [
          { fileName: 'abc.mp3', absolutePath: 'D:/1/A/abc.mp3', sourceRoot: 'D:/1', pathTags: ['A'], transcriptTrusted: false },
          { fileName: 'main.wav', absolutePath: 'D:/refs/hero/main.wav', sourceRoot: 'D:/refs', pathTags: ['hero'], transcriptTrusted: false },
          { fileName: 'aux.wav', absolutePath: 'D:/refs/hero/alternate/aux.wav', sourceRoot: 'D:/refs', pathTags: ['hero', 'alternate'], transcriptTrusted: false },
        ], issues: [], truncated: false,
      })),
      pickReferenceAudio: vi.fn(async (multiple: boolean) => multiple ? ['D:/picked/auxiliary.wav'] : ['D:/picked/primary.mp3']),
      discardSession: vi.fn(async () => ({ success: true })),
    } as any;
    render(<VoiceWorkbench isOpen context={{ mode: 'free' }} project={null} config={{ apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' }} service={service} onClose={() => undefined} />);

    const referencePicker = screen.getByRole('button', { name: '选择参考音频' });
    fireEvent.click(referencePicker);
    await waitFor(() => expect((screen.getByPlaceholderText('填写参考音频中准确说出的内容') as HTMLTextAreaElement).value).toBe('primary'));
    fireEvent.click(screen.getByRole('button', { name: '选择辅助参考音频' }));
    await waitFor(() => expect((screen.getByPlaceholderText('填写参考音频中准确说出的内容') as HTMLTextAreaElement).value).toBe('primary'));
    expect(screen.getByRole('combobox', { name: '辅助参考音频 1' }).textContent).toContain('auxiliary.wav');
    fireEvent.click(screen.getByRole('button', { name: '移除辅助参考音频 1' }));
    await waitFor(() => expect(screen.queryByRole('combobox', { name: '辅助参考音频 1' })).toBeNull());

    const combobox = screen.getByRole('combobox', { name: '参考音频' });
    fireEvent.click(combobox);
    const groupPane = await screen.findByRole('listbox', { name: '选项分组' });
    expect(within(groupPane).getByRole('option', { name: 'A' })).toBeTruthy();
    expect(within(groupPane).queryByRole('option', { name: '1\\A' })).toBeNull();
    expect(within(groupPane).getByRole('option', { name: 'hero' })).toBeTruthy();
    expect(within(groupPane).getByRole('option', { name: 'hero\\alternate' })).toBeTruthy();
    expect(within(groupPane).queryByRole('option', { name: 'refs\\hero' })).toBeNull();

    fireEvent.click(within(groupPane).getByRole('option', { name: 'A' }));
    fireEvent.click(within(document.getElementById(combobox.getAttribute('aria-controls') || '')!).getByRole('option', { name: 'abc' }));
    await waitFor(() => {
      expect(combobox.textContent).toContain('A\\abc');
      expect(combobox.textContent).not.toContain('1\\A\\abc');
      expect(combobox.textContent).not.toContain('.mp3');
    });

    fireEvent.click(combobox);
    const reopenedGroupPane = await screen.findByRole('listbox', { name: '选项分组' });
    fireEvent.click(within(reopenedGroupPane).getByRole('option', { name: 'hero' }));
    await waitFor(() => {
      const listboxText = document.getElementById(combobox.getAttribute('aria-controls') || '')?.textContent ?? '';
      expect(listboxText).toContain('main');
      expect(listboxText).not.toContain('aux');
    });

    fireEvent.click(within(reopenedGroupPane).getByRole('option', { name: 'hero\\alternate' }));
    await waitFor(() => {
      const listboxText = document.getElementById(combobox.getAttribute('aria-controls') || '')?.textContent ?? '';
      expect(listboxText).toContain('aux');
      expect(listboxText).not.toContain('main');
    });
  });

  it('filters voice presets by model pair and automatically loads a unique match', async () => {
    const preset = {
      id: 'anon', name: '爱音 兴奋',
      gptModel: { absolutePath: 'D:/models/anon.ckpt', fileName: 'anon.ckpt' },
      sovitsModel: { absolutePath: 'D:/models/anon.pth', fileName: 'anon.pth' },
      references: [{ id: 'primary', label: 'Excited', managedPath: 'references/anon/primary.mp3', role: 'primary', promptText: 'ありがとう', promptLang: 'all_ja' }],
      inferenceDefaults: { textLang: 'all_ja', speed: 1 }, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    };
    const service = {
      listPresets: vi.fn(async () => ({ success: true, library: { schemaVersion: 1, presets: [preset] } })),
      scanCatalog: vi.fn(async () => ({
        models: [
          { kind: 'gpt', fileName: 'anon.ckpt', absolutePath: 'D:/models/anon.ckpt', sourceRoot: 'D:/models' },
          { kind: 'gpt', fileName: 'other.ckpt', absolutePath: 'D:/models/other.ckpt', sourceRoot: 'D:/models' },
          { kind: 'sovits', fileName: 'anon.pth', absolutePath: 'D:/models/anon.pth', sourceRoot: 'D:/models' },
          { kind: 'sovits', fileName: 'other.pth', absolutePath: 'D:/models/other.pth', sourceRoot: 'D:/models' },
        ], references: [], issues: [], truncated: false,
      })),
      resolveReference: vi.fn(async () => ({ success: true, absolutePath: 'D:/managed/anon.mp3' })),
      discardSession: vi.fn(async () => ({ success: true })),
    } as any;

    render(<VoiceWorkbench isOpen context={{ mode: 'free' }} project={null} config={{ apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' }} service={service} onClose={() => undefined} />);
    await chooseFormSelect('GPT 模型', 'anon.ckpt');

    await waitFor(() => expect(screen.getByRole('combobox', { name: '匹配音色' }).textContent).toContain('爱音 兴奋'));
    expect(screen.getByRole('combobox', { name: 'SoVITS 模型' }).textContent).toContain('anon.pth');
  });

  it('shows the dialogue character and loads its local default voice profile', async () => {
    const preset = {
      id: 'anon', name: '爱音默认',
      gptModel: { absolutePath: 'D:/models/anon.ckpt', fileName: 'anon.ckpt' },
      sovitsModel: { absolutePath: 'D:/models/anon.pth', fileName: 'anon.pth' },
      references: [{ id: 'primary', label: 'Main', managedPath: 'references/anon/primary.mp3', role: 'primary', promptText: 'ありがとう', promptLang: 'all_ja' }],
      inferenceDefaults: { textLang: 'all_ja', speed: 1 }, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    };
    const projectProfile = {
      id: 'anon', name: '爱音默认',
      gptModel: { fileName: 'anon.ckpt' }, sovitsModel: { fileName: 'anon.pth' },
      references: [{ id: 'primary', label: 'Main', projectPath: 'vocal/reference/anon/primary.mp3', role: 'primary', promptText: 'ありがとう', promptLang: 'all_ja' }],
      inferenceDefaults: { textLang: 'all_ja', speed: 1 },
    };
    const service = {
      listPresets: vi.fn(async () => ({ success: true, library: { schemaVersion: 1, presets: [preset] } })),
      scanCatalog: vi.fn(async () => ({
        models: [
          { kind: 'gpt', fileName: 'anon.ckpt', absolutePath: 'D:/models/anon.ckpt', sourceRoot: 'D:/models' },
          { kind: 'sovits', fileName: 'anon.pth', absolutePath: 'D:/models/anon.pth', sourceRoot: 'D:/models' },
        ], references: [], issues: [], truncated: false,
      })),
      resolveReference: vi.fn(async () => ({ success: true, absolutePath: 'D:/managed/anon.mp3' })),
      resolveProjectReference: vi.fn(async () => 'D:/project/vocal/reference/anon/primary.mp3'),
      discardSession: vi.fn(async () => ({ success: true })),
    } as any;
    const project = { metadata: { projectId: 'project-1', voiceProfiles: [projectProfile] } } as any;

    render(<VoiceWorkbench isOpen context={{ mode: 'dialogue', characterId: 'anon', characterName: '千早爱音', voiceProfileId: 'anon', text: '测试' }} project={project} config={{ apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' }} service={service} onClose={() => undefined} />);

    expect(await screen.findByText('千早爱音')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('combobox', { name: '匹配音色' }).textContent).toContain('爱音默认'));
    expect(screen.getAllByText('爱音默认').length).toBeGreaterThan(0);
  });

  it('can save a configured voice and assign it as the current character default', async () => {
    const savePreset = vi.fn(async (request: any) => ({ success: true, preset: { ...request.preset, createdAt: '2026-01-01', updatedAt: '2026-01-01' } }));
    const setCharacterDefault = vi.fn(async () => ({ success: true }));
    const service = {
      listPresets: vi.fn(async () => ({ success: true, library: { schemaVersion: 1, presets: [] } })),
      scanCatalog: vi.fn(async () => ({
        models: [
          { kind: 'gpt', fileName: 'anon.ckpt', absolutePath: 'D:/models/anon.ckpt', sourceRoot: 'D:/models' },
          { kind: 'sovits', fileName: 'anon.pth', absolutePath: 'D:/models/anon.pth', sourceRoot: 'D:/models' },
        ],
        references: [{ fileName: 'main.mp3', absolutePath: 'D:/refs/main.mp3', sourceRoot: 'D:/refs', pathTags: [], transcriptTrusted: false }],
        issues: [], truncated: false,
      })),
      savePreset, setCharacterDefault,
      discardSession: vi.fn(async () => ({ success: true })),
    } as any;
    const project = { metadata: { projectId: 'project-1', voiceProfiles: [] } } as any;

    render(<VoiceWorkbench isOpen context={{ mode: 'dialogue', characterId: 'anon', characterName: '千早爱音', text: '测试' }} project={project} config={{ apiHost: '127.0.0.1', apiPort: 9880, rootPath: 'D:/GPT-SoVITS' }} service={service} onClose={() => undefined} />);
    await chooseFormSelect('GPT 模型', 'anon.ckpt');
    await chooseFormSelect('参考音频', 'main');
    fireEvent.change(screen.getByPlaceholderText('填写参考音频中准确说出的内容'), { target: { value: 'ありがとうございます' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并设为角色默认' }));

    await waitFor(() => expect(setCharacterDefault).toHaveBeenCalledTimes(1));
    expect(savePreset).toHaveBeenCalledWith(expect.objectContaining({ preset: expect.objectContaining({ name: '千早爱音 音色' }) }));
    expect(setCharacterDefault).toHaveBeenCalledWith(expect.objectContaining({ name: '千早爱音 音色' }), 'anon');
  });
});
