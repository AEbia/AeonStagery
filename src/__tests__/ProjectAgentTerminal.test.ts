import { describe, expect, it } from 'vitest';
import {
  buildPowerShellEncodedScript,
  decodeTerminalBuffer,
  projectAgentTerminalSpawnSpec,
  resolveProjectAgentTerminalShell,
} from '../../electron/projectAgentTerminal';

describe('project Agent terminal selection', () => {
  it('uses PowerShell for an unspecified shell on Windows with safe encoded script', () => {
    expect(resolveProjectAgentTerminalShell(undefined, 'win32')).toBe('powershell');
    expect(resolveProjectAgentTerminalShell('default', 'win32')).toBe('powershell');

    const spec = projectAgentTerminalSpawnSpec('powershell', 'Get-Location', 'win32');
    expect(spec.file).toBe('pwsh');
    expect(spec.fallbackFile).toBe('powershell.exe');
    expect(spec.args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);

    // Decode UTF-16LE Base64 and verify content
    const decodedScript = Buffer.from(spec.args[4], 'base64').toString('utf16le');
    expect(decodedScript).toBe(buildPowerShellEncodedScript('Get-Location'));
    expect(decodedScript).toContain('New-Object System.Text.UTF8Encoding $false');
    expect(decodedScript).toContain('chcp 65001 >$null;');
    expect(decodedScript).toContain('Get-Location');
    expect(decodedScript).toContain('exit $LASTEXITCODE');
  });

  it('preserves the default shell outside Windows and supports explicit PowerShell', () => {
    expect(resolveProjectAgentTerminalShell(undefined, 'linux')).toBe('default');
    expect(resolveProjectAgentTerminalShell('powershell', 'linux')).toBe('powershell');

    const psSpec = projectAgentTerminalSpawnSpec('powershell', 'Get-Location', 'linux');
    expect(psSpec.file).toBe('pwsh');
    expect(psSpec.fallbackFile).toBeUndefined();
    expect(psSpec.args[3]).toBe('-EncodedCommand');
    const decodedPsScript = Buffer.from(psSpec.args[4], 'base64').toString('utf16le');
    expect(decodedPsScript).toContain('Get-Location');

    const defaultSpec = projectAgentTerminalSpawnSpec('default', 'ls -la', 'linux');
    expect(defaultSpec).toEqual({
      file: process.env.SHELL || '/bin/sh',
      args: ['-lc', 'ls -la'],
    });
  });
});

describe('decodeTerminalBuffer encoding resilience', () => {
  it('handles empty buffer and pure ASCII text cleanly', () => {
    expect(decodeTerminalBuffer(Buffer.alloc(0))).toBe('');
    expect(decodeTerminalBuffer(Buffer.from('hello world'))).toBe('hello world');
  });

  it('correctly decodes standard UTF-8 strings and handles truncation cleanly', () => {
    const utf8Buf = Buffer.from('你好，世界！', 'utf8');
    expect(decodeTerminalBuffer(utf8Buf)).toBe('你好，世界！');

    // Truncated to 5 bytes ('你' is 3 bytes, first 2 bytes of '好')
    const cutBuf = utf8Buf.subarray(0, 5);
    expect(decodeTerminalBuffer(cutBuf)).toContain('你');
  });

  it('automatically falls back to GBK when input is Windows CP936 encoded', () => {
    // GBK bytes for "操作成功" (0xB2 0xD9 0xD7 0xF7 0xB3 0xC9 0xB9 0xA6)
    const gbkBuf = Buffer.from([0xb2, 0xd9, 0xd7, 0xf7, 0xb3, 0xc9, 0xb9, 0xa6]);
    expect(decodeTerminalBuffer(gbkBuf)).toBe('操作成功');
  });

  it('decodes mixed ASCII and GBK command outputs', () => {
    const mixedGbk = Buffer.concat([
      Buffer.from([0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xce, 0xc4, 0xbc, 0xfe, 0x3a, 0x20]), // 找不到文件: 
      Buffer.from('test.txt'),
    ]);
    expect(decodeTerminalBuffer(mixedGbk)).toBe('找不到文件: test.txt');
  });
});

