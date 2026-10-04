import { describe, it, expect, beforeEach } from 'vitest';
import { ProxyRegistry } from '../engine/coordinators/ProxyRegistry';

describe('ProxyRegistry', () => {
  let registry: ProxyRegistry;

  beforeEach(() => {
    registry = new ProxyRegistry();
  });

  it('get returns undefined for unknown id', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('set creates a proxy with default values plus the given partial', () => {
    registry.set('char1', { x: 100, y: 200 });
    const p = registry.get('char1')!;
    expect(p.x).toBe(100);
    expect(p.y).toBe(200);
    // Defaults
    expect(p.scale).toBe(1);
    expect(p.rotation).toBe(0);
    expect(p.opacity).toBe(1);
    expect(p.z).toBe(0);
  });

  it('set merges into existing proxy without overwriting scale or opacity to 0', () => {
    registry.set('char1', { x: 100, y: 200, z: 5 });
    registry.set('char1', { scale: 2.0 });
    const p = registry.get('char1')!;
    expect(p.x).toBe(100);      // preserved
    expect(p.y).toBe(200);      // preserved
    expect(p.z).toBe(5);        // preserved
    expect(p.scale).toBe(2.0);  // updated
    expect(p.opacity).toBe(1);  // default preserved
  });

  it('returns a mutable reference that GSAP can directly modify', () => {
    registry.set('char1', { x: 100, y: 200 });
    const proxy = registry.get('char1')!;
    
    // GSAP direct mutations simulation
    proxy.x = 300;
    proxy.scale = 1.5;

    // Verify it changed the object inside the registry directly
    const internalProxy = registry.get('char1')!;
    expect(internalProxy.x).toBe(300);
    expect(internalProxy.scale).toBe(1.5);
  });

  it('delete removes the proxy', () => {
    registry.set('char1', { x: 0, y: 0 });
    expect(registry.get('char1')).toBeDefined();
    registry.delete('char1');
    expect(registry.get('char1')).toBeUndefined();
  });

  it('clear removes all proxies', () => {
    registry.set('a', { x: 0, y: 0 });
    registry.set('b', { x: 0, y: 0 });
    registry.clear();
    expect(registry.get('a')).toBeUndefined();
    expect(registry.get('b')).toBeUndefined();
  });

  it('forEach iterates all proxies', () => {
    registry.set('a', { x: 1, y: 1 });
    registry.set('b', { x: 2, y: 2 });
    const seen: string[] = [];
    registry.forEach((_proxy, id) => seen.push(id));
    expect(seen).toContain('a');
    expect(seen).toContain('b');
    expect(seen.length).toBe(2);
  });
});
