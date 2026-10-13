import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse } from 'node:path';
import { actionError } from './contracts.ts';

/**
 * Protected local files for private action content (02_CONTRACTS "Exact protected preview and approval", acceptance C7).
 * Output: an absolute NEW path whose canonical parent is outside every Git checkout (no ancestor holds a .git marker);
 * created O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW 0600, fchmod 0600 against a restrictive umask, effective-uid owner and one
 * link checked on the same descriptor, written fully and fsynced. Input: O_RDONLY|O_NOFOLLOW|O_NONBLOCK (no FIFO wait), then fstat on THAT descriptor
 * (regular file, exactly 0600, effective-uid owner, one link, at most the limit), bounded read, strict UTF-8 JSON. Never
 * lstat-then-reopen. A trusted local filesystem is assumed (hostile concurrent renames are outside this slice). Paths and
 * contents are never printed; failures are the fixed ACTION_OUTPUT_INVALID / ACTION_OUTPUT_FAILED / ACTION_INPUT_INVALID.
 */
const euid = (): number => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

async function hasGitMarker(dir: string): Promise<boolean> {
  try { await lstat(join(dir, '.git')); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** The canonical parent directory of a new output path, refused inside any Git checkout or worktree. */
async function safeOutputParent(path: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw actionError('ACTION_OUTPUT_INVALID');
  const name = basename(path);
  if (name === '' || name === '.' || name === '..' || path.endsWith('/')) throw actionError('ACTION_OUTPUT_INVALID');
  let parent: string;
  try { parent = await realpath(dirname(path)); } catch { throw actionError('ACTION_OUTPUT_INVALID'); }
  const root = parse(parent).root;
  for (let dir = parent; ; dir = dirname(dir)) {
    if (await hasGitMarker(dir).catch(() => true)) throw actionError('ACTION_OUTPUT_INVALID');
    if (dir === root) break;
  }
  return join(parent, name);
}

/** Writes `content` to a new protected file. Never overwrites, never follows a final symlink, never prints the path. */
export async function writeProtectedFile(path: string, content: string): Promise<void> {
  const target = await safeOutputParent(path);
  let handle;
  try {
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw actionError(code === 'EEXIST' || code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR' ? 'ACTION_OUTPUT_INVALID' : 'ACTION_OUTPUT_FAILED');
  }
  try {
    await handle.chmod(0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== euid() || (stat.mode & 0o777) !== 0o600) throw actionError('ACTION_OUTPUT_FAILED');
    const bytes = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written)).bytesWritten;
    await handle.sync();
  } catch (error) {
    await handle.truncate(0).catch(() => undefined); // no partial private content stays behind
    throw error instanceof Error && error.name === 'AtlasError' ? error : actionError('ACTION_OUTPUT_FAILED');
  } finally { await handle.close().catch(() => undefined); }
}

/** Reads a protected JSON file (input or approval/reconciliation material). Exact 0600, own, single link, bounded. */
export async function readProtectedJson(path: string, maxBytes: number): Promise<unknown> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw actionError('ACTION_INPUT_INVALID');
  let handle;
  // O_NONBLOCK: opening a FIFO without a writer (or a device) must not wait before the descriptor's type is checked.
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw actionError('ACTION_INPUT_INVALID'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== euid() || stat.nlink !== 1 || stat.size > maxBytes) {
      throw actionError('ACTION_INPUT_INVALID');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw actionError('ACTION_INPUT_INVALID');
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, total)); } catch { throw actionError('ACTION_INPUT_INVALID'); }
    try { return JSON.parse(text); } catch { throw actionError('ACTION_INPUT_INVALID'); }
  } catch (error) {
    throw error instanceof Error && error.name === 'AtlasError' ? error : actionError('ACTION_INPUT_INVALID');
  } finally { await handle.close().catch(() => undefined); }
}
