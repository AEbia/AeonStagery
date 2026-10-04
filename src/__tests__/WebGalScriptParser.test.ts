import { describe, expect, it } from 'vitest';
import { parseWebGalScript } from '../services/import/webgal/WebGalScriptParser';

describe('parseWebGalScript', () => {
  it('parses a narration sentence', () => {
    const { sentences } = parseWebGalScript(':这是旁白。;');
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatchObject({
      kind: 'narration',
      text: '这是旁白。',
      lineNumber: 1,
    });
  });

  it('parses a narration without a trailing separator', () => {
    const { sentences } = parseWebGalScript(':没有分号结尾');
    expect(sentences[0]).toMatchObject({ kind: 'narration', text: '没有分号结尾' });
  });

  it('parses a speaker dialogue with flags', () => {
    const { sentences } = parseWebGalScript('Anon:啊，soyorin。 -id=2 -figureId=2;');
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatchObject({
      kind: 'dialogue',
      speaker: 'Anon',
      text: '啊，soyorin。',
      flags: { id: '2', figureId: '2' },
    });
  });

  it('parses a multi-speaker dialogue', () => {
    const { sentences } = parseWebGalScript('Anon & Soyo:感谢在场的大家！;');
    expect(sentences[0]).toMatchObject({
      kind: 'dialogue',
      speaker: 'Anon & Soyo',
      text: '感谢在场的大家！',
    });
  });

  it('parses changeBg with a -next flag', () => {
    const { sentences } = parseWebGalScript('changeBg:G（月之森）/G5.png -next;');
    expect(sentences[0]).toMatchObject({
      kind: 'command',
      command: 'changebg',
      content: 'G（月之森）/G5.png',
      flags: { next: undefined },
    });
  });

  it('parses changeFigure with complex flags including JSON values', () => {
    const { sentences } = parseWebGalScript(
      'changeFigure:soyo/school_winter-2023/model.json -next -motion=soyo/gacha_b2024_01 '
      + '-id=1 -transform={"position":{"x":-400},"scale":{"x":0.8,"y":0.8}} -blink={"blinkInterval":5000};',
    );
    expect(sentences[0]).toMatchObject({
      kind: 'command',
      command: 'changefigure',
      content: 'soyo/school_winter-2023/model.json',
      flags: {
        next: undefined,
        motion: 'soyo/gacha_b2024_01',
        id: '1',
      },
    });
    const sentence = sentences[0];
    if (sentence?.kind !== 'command') throw new Error('expected command');
    expect(sentence.flags.transform).toContain('"x":-400');
    expect(sentence.flags.blink).toBe('{"blinkInterval":5000}');
  });

  it('parses changeFigure:none as a figure removal command', () => {
    const { sentences } = parseWebGalScript('changeFigure:none -id=1;');
    expect(sentences[0]).toMatchObject({
      kind: 'command',
      command: 'changefigure',
      content: 'none',
      flags: { id: '1' },
    });
  });

  it('parses setTransform with duration and target', () => {
    const { sentences } = parseWebGalScript('setTransform:{"alpha":0.95} -next -duration=400 -target=2;');
    expect(sentences[0]).toMatchObject({
      kind: 'command',
      command: 'settransform',
      content: '{"alpha":0.95}',
      flags: { next: undefined, duration: '400', target: '2' },
    });
  });

  it('splits multiple sentences on one line', () => {
    const { sentences } = parseWebGalScript(':第一句;changeBg:A.png;:第二句;');
    expect(sentences.map((s) => s.kind)).toEqual(['narration', 'command', 'narration']);
  });

  it('strips full-line and block comments and keeps content lines', () => {
    const script = [
      '// 这是一个注释',
      '## 章节标题',
      ':真正的台词;',
      '/* 多行',
      '注释 */',
      'changeBg:B.png;',
    ].join('\n');
    const { sentences } = parseWebGalScript(script);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({ kind: 'narration', text: '真正的台词' });
    expect(sentences[1]).toMatchObject({ command: 'changebg', content: 'B.png' });
  });

  it('strips an inline comment after a sentence separator', () => {
    const { sentences } = parseWebGalScript(':台词; // 尾部注释\nchangeBg:C.png;');
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toMatchObject({ kind: 'narration', text: '台词' });
    expect(sentences[1]).toMatchObject({ command: 'changebg', content: 'C.png' });
  });

  it('tracks accurate line numbers across comment removal', () => {
    const script = [
      '// 注释',
      ':第一行;',
      ':第二行;',
    ].join('\n');
    const { sentences } = parseWebGalScript(script);
    expect(sentences.map((s) => s.lineNumber)).toEqual([2, 3]);
  });

  it('treats an unknown prefix as a speaker', () => {
    const { sentences } = parseWebGalScript('RandomCharacter:你好;');
    expect(sentences[0]).toMatchObject({
      kind: 'dialogue',
      speaker: 'RandomCharacter',
    });
  });

  it('preserves hyphens in dialogue text when not matching flag patterns', () => {
    const { sentences } = parseWebGalScript('Soyo:2024-08-17 - 晴朗的一天;');
    expect(sentences[0]).toMatchObject({
      kind: 'dialogue',
      speaker: 'Soyo',
      text: '2024-08-17 - 晴朗的一天',
      flags: {},
    });
  });

  it('correctly parses JSON flags containing spaced negative numbers without breaking', () => {
    const { sentences } = parseWebGalScript('changeFigure:soyo/model.json -transform={"position":{"x": -100, "y": -200}} -next;');
    expect(sentences[0]).toMatchObject({
      kind: 'command',
      command: 'changefigure',
      content: 'soyo/model.json',
      flags: {
        transform: '{"position":{"x": -100, "y": -200}}',
        next: undefined,
      },
    });
  });

  it('recognizes modern audio and visual commands as commands, not speakers', () => {
    const { sentences } = parseWebGalScript(
      'bgm:music/bgm.ogg;'
      + 'playEffect:rain.wav -id=rain;'
      + 'intro:第一行|第二行;'
      + 'setTempAnimation:[{"duration":0}] -target=aaa;'
      + 'setComplexAnimation:universalSoftIn -target=aaa -duration=1000;'
      + 'setTransition: -target=aaa -enter=enter-from-left;'
      + 'wait:2000;',
    );
    expect(sentences.map((s) => s.kind)).toEqual([
      'command', 'command', 'command', 'command', 'command', 'command', 'command',
    ]);
    expect(sentences.map((s) => s.kind === 'command' ? (s as { command: string }).command : '')).toEqual([
      'bgm', 'playeffect', 'intro', 'settempanimation', 'setcomplexanimation', 'settransition', 'wait',
    ]);
  });

  it('recognizes interaction and game-only commands instead of speakers', () => {
    const { sentences } = parseWebGalScript(
      'getUserInput:player_name -title=名字;'
      + 'applyStyle:TextBox_main->TextBox_Black;'
      + 'filmMode:on;'
      + 'miniAvatar:char_a/avatar.png;'
      + 'unlockCg:cg.png -name=CG01;'
      + 'pixiPerform:rain;'
      + 'callSteam:achievement;',
    );
    expect(sentences.every((s) => s.kind === 'command')).toBe(true);
    expect(sentences.map((s) => s.kind === 'command' ? (s as { command: string }).command : '')).toEqual([
      'getuserinput', 'applystyle', 'filmmode', 'miniavatar', 'unlockcg', 'pixiperform', 'callsteam',
    ]);
  });

  it('recognizes legacy visual-effect commands instead of speakers', () => {
    const { sentences } = parseWebGalScript(
      'changeFilter:blur;'
      + 'flash:white;'
      + 'shake:10;'
      + 'light:{"x":100};'
      + 'camera:zoom;'
      + 'playVocal:voice.wav;',
    );
    expect(sentences.every((s) => s.kind === 'command')).toBe(true);
    expect(sentences.map((s) => s.kind === 'command' ? (s as { command: string }).command : '')).toEqual([
      'changefilter', 'flash', 'shake', 'light', 'camera', 'playvocal',
    ]);
  });
});
