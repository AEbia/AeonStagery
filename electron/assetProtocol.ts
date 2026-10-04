import * as fs from 'fs';
import * as path from 'path';

function healPath(filePath: string): string {
  let currentPath = filePath.replace(/\\/g, '/');

  if (currentPath.includes('?') || currentPath.includes('\uFFFD')) {
    const parts = currentPath.split('/');
    let resolved = '';

    if (parts[0] && parts[0].includes(':')) {
      resolved = parts[0];
      parts.shift();
    }

    for (const part of parts) {
      if (!part) continue;

      if (part.includes('?') || part.includes('\uFFFD')) {
        const garbledChar = part.includes('?') ? '?' : '\uFFFD';
        const testPath = resolved ? `${resolved}/${part}` : part;
        if (fs.existsSync(testPath)) {
          resolved = testPath;
          continue;
        }

        if (resolved && fs.existsSync(resolved)) {
          try {
            const files = fs.readdirSync(resolved);
            const idx = part.indexOf(garbledChar);
            const prefix = part.substring(0, idx);
            const suffix = part.substring(idx + 1);

            // Try to find a directory that starts with the prefix.
            const matchedDir = files.find((file) => {
              try {
                const stats = fs.statSync(path.join(resolved, file));
                return stats.isDirectory() && file.toLowerCase().startsWith(prefix.toLowerCase());
              } catch {
                return false;
              }
            });

            if (matchedDir) {
              const healedSubPath = path.join(resolved, matchedDir, suffix);
              if (fs.existsSync(healedSubPath)) {
                resolved = healedSubPath;
                console.log(`[Path Healer] Healed garbled path: ${part} -> ${matchedDir}/${suffix}`);
                continue;
              }
            }

            // Standard regex character match if prefix match did not yield a direct file.
            const escapedPart = part
              .replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
              .replace(/\\\?/g, '.')
              .replace(/\uFFFD/g, '.');
            const regex = new RegExp(`^${escapedPart}$`, 'i');
            const matchedFile = files.find((file) => regex.test(file));
            if (matchedFile) {
              resolved = path.join(resolved, matchedFile);
              continue;
            }
          } catch (error) {
            console.error('[Path Healer] Error during fuzzy match:', error);
          }
        }
      }

      resolved = resolved ? `${resolved}/${part}` : part;
    }
    return resolved;
  }

  return filePath;
}

/**
 * Handles one asset protocol request, including legacy path repair, Live2D
 * sidecar fallback, MIME headers, and byte-range responses.
 */
export async function handleAssetProtocolRequest(request: Request): Promise<Response> {
  const urlStr = request.url;
  let pathPart = '';

  if (urlStr.startsWith('asset://localhost/')) {
    pathPart = urlStr.slice(18);
  } else if (urlStr.startsWith('asset:///')) {
    pathPart = urlStr.slice(9);
  } else {
    pathPart = urlStr.replace(/^asset:\/\//, '');
  }

  // Decode and handle Windows absolute path slash issues.
  const decodedPath = decodeURIComponent(pathPart);
  let absolutePath = decodedPath;
  if (absolutePath.startsWith('/') && /^[a-zA-Z]:/.test(absolutePath.slice(1))) {
    absolutePath = absolutePath.slice(1);
  }

  absolutePath = healPath(absolutePath);

  try {
    const normalPath = path.normalize(absolutePath);
    let data: Buffer;
    let finalPath = normalPath;

    try {
      data = await fs.promises.readFile(normalPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;

      const dir = path.dirname(normalPath);
      let ext = path.extname(normalPath).toLowerCase();
      if (normalPath.toLowerCase().endsWith('.physics.json')) {
        ext = '.physics.json';
      } else if (normalPath.toLowerCase().endsWith('.pose.json')) {
        ext = '.pose.json';
      } else if (normalPath.toLowerCase().endsWith('.model.json')) {
        ext = '.model.json';
      }

      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        const candidates = files.filter((file) => file.toLowerCase().endsWith(ext));
        if (candidates.length > 0) {
          let bestCandidate = candidates[0];
          if (candidates.length > 1) {
            // Prefer the sidecar whose basename matches the model's moc file.
            const mocFile = files.find((file) => file.toLowerCase().endsWith('.moc'));
            if (mocFile) {
              const mocBase = path.basename(mocFile, path.extname(mocFile)).toLowerCase();
              const matchingMoc = candidates.find((candidate) => (
                path.basename(candidate, ext).toLowerCase().startsWith(mocBase)
              ));
              if (matchingMoc) bestCandidate = matchingMoc;
            }
          }
          finalPath = path.join(dir, bestCandidate);
          console.log(`[Protocol Fallback] File not found: ${normalPath}. Falling back to: ${finalPath}`);
          data = await fs.promises.readFile(finalPath);
        } else if (ext === '.physics.json' || ext === '.pose.json') {
          console.log(`[Protocol Fallback] Physics/Pose file completely missing: ${normalPath}. Serving dummy empty JSON.`);
          data = Buffer.from('{}');
        } else {
          throw error;
        }
      } else if (ext === '.physics.json' || ext === '.pose.json') {
        console.log(`[Protocol Fallback] Directory missing for physics/pose: ${normalPath}. Serving dummy empty JSON.`);
        data = Buffer.from('{}');
      } else {
        throw error;
      }
    }

    const extName = path.extname(finalPath).toLowerCase().slice(1);
    const mimeTypes: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
      gif: 'image/gif', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav',
      ogg: 'audio/ogg', json: 'application/json', 'model3.json': 'application/json',
    };
    const totalSize = data.length;
    const commonHeaders: Record<string, string> = {
      'Content-Type': mimeTypes[extName] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Accept-Ranges': 'bytes',
    };
    const rangeHeader = request.headers.get('range');

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const requestedStart = match[1] ? Number.parseInt(match[1], 10) : NaN;
        const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : NaN;
        let start = Number.isNaN(requestedStart) ? 0 : requestedStart;
        let end = Number.isNaN(requestedEnd) ? totalSize - 1 : requestedEnd;

        if (Number.isNaN(requestedStart) && !Number.isNaN(requestedEnd)) {
          start = Math.max(totalSize - requestedEnd, 0);
          end = totalSize - 1;
        }

        if (start >= totalSize || end < start) {
          return new Response(null, {
            status: 416,
            headers: {
              ...commonHeaders,
              'Content-Range': `bytes */${totalSize}`,
            },
          });
        }

        end = Math.min(end, totalSize - 1);
        const chunk = data.subarray(start, end + 1);
        const chunkBody = chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength,
        ) as ArrayBuffer;
        return new Response(chunkBody, {
          status: 206,
          headers: {
            ...commonHeaders,
            'Content-Length': String(chunk.length),
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          },
        });
      }
    }

    const body = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        ...commonHeaders,
        'Content-Length': String(totalSize),
      },
    });
  } catch (error) {
    console.error('[Protocol] Error loading:', absolutePath, error);
    return new Response('Not Found', { status: 404 });
  }
}
