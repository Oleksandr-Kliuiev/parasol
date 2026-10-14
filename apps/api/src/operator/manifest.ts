// Operator console asset manifest format, shared by the build (scripts/operator-build.ts) and the server loader (assets.ts).
// The asset directory is flat: a name is one path segment with a fixed extension, so no manifest entry can name a
// subdirectory, a parent, a dotfile or a source/configuration file.

export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_FORMAT = 'atlas-operator-assets-v1';
/** Names the build may emit and the server may serve; the manifest itself is never an asset. PNG is the static brand logo only. */
export const SERVABLE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}\.(html|css|js|png)$/;
export const MAX_ASSETS = 64;
export const MAX_ASSET_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;

export const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png'
});

export interface ManifestEntry { path: string; bytes: number; sha256: string }
