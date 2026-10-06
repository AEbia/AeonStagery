import { describe, expect, it } from 'vitest';
import type { CollaborationServerStatus } from '../api/types/collaboration';
import { isMatchingCollaborationServerHost } from '../services/collaboration/CollaborationTransport';

describe('isMatchingCollaborationServerHost', () => {
  const baseStatus: CollaborationServerStatus = {
    running: true,
    host: '0.0.0.0',
    port: 12345,
    dataDir: '/data',
    localUrl: 'http://127.0.0.1:12345',
    lanUrls: ['http://192.168.1.100:12345'],
    inviteUrls: ['http://192.168.1.100:12345#token=secret123'],
    assetRoot: '/data/assets',
    hasState: true,
  };

  it('returns false if server status is null, undefined, or not running', () => {
    expect(isMatchingCollaborationServerHost('http://127.0.0.1:12345', null)).toBe(false);
    expect(isMatchingCollaborationServerHost('http://127.0.0.1:12345', undefined)).toBe(false);
    expect(isMatchingCollaborationServerHost('http://127.0.0.1:12345', { ...baseStatus, running: false })).toBe(false);
  });

  it('identifies loopback addresses on matching port as host', () => {
    expect(isMatchingCollaborationServerHost('127.0.0.1:12345', baseStatus)).toBe(true);
    expect(isMatchingCollaborationServerHost('http://127.0.0.1:12345', baseStatus)).toBe(true);
    expect(isMatchingCollaborationServerHost('localhost:12345', baseStatus)).toBe(true);
    expect(isMatchingCollaborationServerHost('http://localhost:12345', baseStatus)).toBe(true);
    expect(isMatchingCollaborationServerHost('http://127.0.0.1:12345#token=abc', baseStatus)).toBe(true);
    expect(isMatchingCollaborationServerHost('0.0.0.0:12345', baseStatus)).toBe(true);
  });

  it('identifies matching LAN urls and invite URLs as host', () => {
    expect(isMatchingCollaborationServerHost('http://192.168.1.100:12345', baseStatus)).toBe(true);
    expect(isMatchingCollaborationServerHost('192.168.1.100:12345', baseStatus)).toBe(true);
    expect(isMatchingCollaborationServerHost('http://192.168.1.100:12345#token=secret123', baseStatus)).toBe(true);
  });

  it('returns false when port does not match', () => {
    expect(isMatchingCollaborationServerHost('http://127.0.0.1:54321', baseStatus)).toBe(false);
    expect(isMatchingCollaborationServerHost('192.168.1.100:8080', baseStatus)).toBe(false);
  });

  it('returns false for foreign hosts on the same network', () => {
    expect(isMatchingCollaborationServerHost('http://192.168.1.200:12345', baseStatus)).toBe(false);
    expect(isMatchingCollaborationServerHost('http://example.com:12345', baseStatus)).toBe(false);
  });

  it('handles invalid or empty endpoints gracefully', () => {
    expect(isMatchingCollaborationServerHost('', baseStatus)).toBe(false);
    expect(isMatchingCollaborationServerHost('   ', baseStatus)).toBe(false);
    expect(isMatchingCollaborationServerHost('invalid://host', baseStatus)).toBe(false);
  });
});
