import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONTENT_TYPES, MANIFEST_FORMAT, MANIFEST_NAME, MAX_ASSET_BYTES, MAX_ASSETS, MAX_MANIFEST_BYTES, SERVABLE_NAME_PATTERN } from './manifest.ts';

/** Fixed startup failure code: the console was enabled but its built assets are missing or do not match their manifest. */
export const ASSETS_UNAVAILABLE = 'OPERATOR_UI_ASSETS_UNAVAILABLE';

export interface OperatorAsset { readonly body: Buffer; readonly contentType: string }
/** Exact request path → asset. `/operator/` is index.html; every other key is `/operator/<flat manifest name>`. */
export type OperatorAssets = ReadonlyMap<string, OperatorAsset>;

/**
 * Loads the generated operator console once, at startup, and keeps it in memory, so requests never touch the filesystem.
 * Only manifest entries are read. Each must be a regular file (not a symlink) whose real path lies directly in the real
 * asset directory, within the size cap, with the manifest's size and SHA-256. Anything else fails closed with the fixed
 * code and no path or detail; the caller refuses to start.
 */
export async function loadOperatorAssets(directory: string): Promise<OperatorAssets> {
  try {
    const root = await realpath(directory);
    const read = async (name: string, max: number): Promise<Buffer> => {
      const path = join(root, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > max || dirname(await realpath(path)) !== root) throw new Error(ASSETS_UNAVAILABLE);
      const body = await readFile(path);
      if (body.byteLength !== info.size) throw new Error(ASSETS_UNAVAILABLE);
      return body;
    };
    const manifest = JSON.parse((await read(MANIFEST_NAME, MAX_MANIFEST_BYTES)).toString('utf8')) as { format?: unknown; files?: unknown };
    if (manifest?.format !== MANIFEST_FORMAT || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > MAX_ASSETS) {
      throw new Error(ASSETS_UNAVAILABLE);
    }
    const assets = new Map<string, OperatorAsset>();
    for (const entry of manifest.files as { path?: unknown; bytes?: unknown; sha256?: unknown }[]) {
      const name = entry?.path;
      if (typeof name !== 'string' || !SERVABLE_NAME_PATTERN.test(name) || typeof entry.sha256 !== 'string' || typeof entry.bytes !== 'number') {
        throw new Error(ASSETS_UNAVAILABLE);
      }
      const key = name === 'index.html' ? '/operator/' : `/operator/${name}`;
      if (assets.has(key)) throw new Error(ASSETS_UNAVAILABLE);
      const body = await read(name, MAX_ASSET_BYTES);
      if (body.byteLength !== entry.bytes || createHash('sha256').update(body).digest('hex') !== entry.sha256) throw new Error(ASSETS_UNAVAILABLE);
      assets.set(key, Object.freeze({ body, contentType: CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)]! }));
    }
    if (!assets.has('/operator/')) throw new Error(ASSETS_UNAVAILABLE);
    return assets;
  } catch {
    throw new Error(ASSETS_UNAVAILABLE);
  }
}
