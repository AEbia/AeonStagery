/**
 * Browser polyfill for Node.js `url` module.
 * Used by pixi-live2d-display which calls `url.resolve()` internally.
 */

export function resolve(from: string, to: string): string {
  // If 'to' is absolute, return it directly
  if (to.match(/^https?:\/\//) || to.match(/^file:\/\//) || to.match(/^[a-zA-Z]:\\/)) {
    return to;
  }

  // Handle relative paths
  try {
    const base = new URL(from, 'file:///');
    const resolved = new URL(to, base);
    return resolved.href;
  } catch {
    // Fallback: simple string concatenation
    const basePath = from.substring(0, from.lastIndexOf('/') + 1);
    return basePath + to;
  }
}

export function parse(urlStr: string) {
  try {
    const u = new URL(urlStr);
    return {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      host: u.host,
      href: u.href,
    };
  } catch {
    return {
      protocol: '',
      hostname: '',
      port: '',
      pathname: urlStr,
      search: '',
      hash: '',
      host: '',
      href: urlStr,
    };
  }
}

export function format(urlObj: any): string {
  if (typeof urlObj === 'string') return urlObj;
  try {
    const u = new URL('http://placeholder');
    if (urlObj.protocol) u.protocol = urlObj.protocol;
    if (urlObj.hostname) u.hostname = urlObj.hostname;
    if (urlObj.port) u.port = urlObj.port;
    if (urlObj.pathname) u.pathname = urlObj.pathname;
    if (urlObj.search) u.search = urlObj.search;
    if (urlObj.hash) u.hash = urlObj.hash;
    return u.href;
  } catch {
    return urlObj.href || '';
  }
}

export default { resolve, parse, format };
