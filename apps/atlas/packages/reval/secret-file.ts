import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsPath } from './scalars.ts';

/**
 * Closed credential files (brief §2b): a secret file is a PURE password — `^[A-Za-z0-9._~-]{16,256}$` plus an optional final
 * newline — so it can never carry a URL, host, port or database (the endpoint comes from the owner config only). The file
 * must be a regular file owned by this user with no group/other permission, reached by its own realpath (no symlinked
 * component), opened with O_NOFOLLOW and re-checked by inode. Errors never echo content.
 */
export class SecretFileError extends Error {
  readonly reason: 'PATH' | 'TYPE' | 'OWNER' | 'MODE' | 'SIZE' | 'CONTENT' | 'IO';
  constructor(reason: SecretFileError['reason']) { super(`SECRET_FILE_${reason}`); this.name = 'SecretFileError'; this.reason = reason; }
}
const PASSWORD = /^[A-Za-z0-9._~-]{16,256}\n?$/;

/** Checks `path` is an owner-private regular file reached without symlinks; returns its lstat. */
export async function privateFileStat(path: string, maxBytes: number) {
  if (!isAbsPath(path)) throw new SecretFileError('PATH');
  let real: string;
  try { real = await realpath(path); } catch { throw new SecretFileError('PATH'); }
  if (real !== path) throw new SecretFileError('PATH');
  const st = await lstat(path).catch(() => { throw new SecretFileError('PATH'); });
  if (!st.isFile() || st.isSymbolicLink()) throw new SecretFileError('TYPE');
  if (st.uid !== process.getuid!()) throw new SecretFileError('OWNER');
  if ((st.mode & 0o077) !== 0) throw new SecretFileError('MODE');
  if (st.size < 1 || st.size > maxBytes) throw new SecretFileError('SIZE');
  return st;
}
/** Reads an owner-private file exactly (O_NOFOLLOW, same inode as checked, bounded). */
export async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer> {
  const st = await privateFileStat(path, maxBytes);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new SecretFileError('IO'); }
  try {
    const fst = await handle.stat();
    if (fst.ino !== st.ino || fst.dev !== st.dev || !fst.isFile() || fst.size !== st.size) throw new SecretFileError('TYPE');
    const buffer = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buffer, 0, st.size, 0);
    if (bytesRead !== st.size) { buffer.fill(0); throw new SecretFileError('IO'); }
    return buffer;
  } finally { await handle.close(); }
}
/**
 * The password of a closed secret file, as a Buffer the caller zero-fills after its single use. The JS string it hands to
 * the pg client cannot be erased (residual, brief §12).
 */
export async function readSecretFile(path: string): Promise<Buffer> {
  const raw = await readPrivateFile(path, 257);
  try {
    if (!PASSWORD.test(raw.toString('latin1'))) throw new SecretFileError('CONTENT');
    const end = raw[raw.length - 1] === 0x0a ? raw.length - 1 : raw.length;
    return Buffer.from(raw.subarray(0, end));
  } finally { raw.fill(0); }
}
