import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleAssetProtocolRequest } from '../../../electron/assetProtocol';

let assetRoot: string;

function makeAssetRequest(filePath: string, headers?: HeadersInit): Request {
  const protocolPath = filePath.replace(/\\/g, '/');
  return new Request(`asset://localhost/${encodeURI(protocolPath)}`, { headers });
}

function writeAsset(fileName: string, contents: string): string {
  const filePath = path.join(assetRoot, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

describe('asset protocol handler', () => {
  beforeEach(() => {
    assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-asset-protocol-'));
  });

  afterEach(() => {
    fs.rmSync(assetRoot, { recursive: true, force: true });
  });

  it('serves an asset with its MIME type and cross-origin headers', async () => {
    const filePath = writeAsset('image.png', 'image-bytes');

    const response = await handleAssetProtocolRequest(makeAssetRequest(filePath));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength('image-bytes')));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(await response.text()).toBe('image-bytes');
  });

  it('serves explicit and suffix byte ranges and rejects unsatisfiable ranges', async () => {
    const filePath = writeAsset('model.moc', 'abcdefgh');

    const partial = await handleAssetProtocolRequest(makeAssetRequest(filePath, { range: 'bytes=2-4' }));
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 2-4/8');
    expect(await partial.text()).toBe('cde');

    const suffix = await handleAssetProtocolRequest(makeAssetRequest(filePath, { range: 'bytes=-3' }));
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('Content-Range')).toBe('bytes 5-7/8');
    expect(await suffix.text()).toBe('fgh');

    const unsatisfiable = await handleAssetProtocolRequest(makeAssetRequest(filePath, { range: 'bytes=8-' }));
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('Content-Range')).toBe('bytes */8');
  });

  it('uses the sidecar matching the model moc when the requested physics file is missing', async () => {
    writeAsset('other.physics.json', 'other-sidecar');
    writeAsset('character.moc', 'model');
    writeAsset('character.physics.json', 'matching-sidecar');

    const response = await handleAssetProtocolRequest(
      makeAssetRequest(path.join(assetRoot, 'missing.physics.json')),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.text()).toBe('matching-sidecar');
  });

  it('serves an empty JSON object when a physics sidecar is absent', async () => {
    const response = await handleAssetProtocolRequest(
      makeAssetRequest(path.join(assetRoot, 'missing.physics.json')),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{}');
  });

  it('returns 404 for a missing non-optional asset', async () => {
    const response = await handleAssetProtocolRequest(
      makeAssetRequest(path.join(assetRoot, 'missing.png')),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });
});
