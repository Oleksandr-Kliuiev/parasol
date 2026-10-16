import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { exact, isBool, isIntIn, shapeFail } from './scalars.ts';

/**
 * Actual Darwin peer proof (brief §2): runs the pinned native helper on a dup of the parent's end of a private AF_UNIX
 * channel. The helper reports the peer's kernel audit-token identity; it is NOT a loaded-image measurement (loadedBinding
 * stays UNVERIFIED). The helper inherits exactly fds 0–2, fd 3 (the channel) and fd 4 (the expected-path pipe) and is
 * killed after 500 ms. Its output is one exact closed line; anything else is a helper failure.
 */
export class PeerError extends Error {
  readonly reason: 'HELPER' | 'PEER';
  constructor(reason: 'HELPER' | 'PEER') { super(`PEER_${reason}`); this.name = 'PeerError'; this.reason = reason; }
}
export interface PeerFacts {
  readonly pid: number; readonly pidversion: number; readonly euid: number; readonly ppid: number;
  readonly startSec: number; readonly startUsec: number; readonly hasTty: boolean; readonly exeMatch: boolean;
}
const INT = (v: unknown) => isIntIn(v, 0, 2 ** 53 - 1);
/** Exactly one line with exactly the eight keys (integers, strict booleans). */
export function decodePeerFacts(text: string): PeerFacts {
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) shapeFail();
  let v: unknown;
  try { v = JSON.parse(text.slice(0, -1)); } catch { shapeFail(); }
  const o = exact(v, ['pid', 'pidversion', 'euid', 'ppid', 'startSec', 'startUsec', 'hasTty', 'exeMatch']);
  for (const k of ['pid', 'pidversion', 'euid', 'ppid', 'startSec', 'startUsec']) if (!INT(o[k])) shapeFail();
  if (!isBool(o.hasTty) || !isBool(o.exeMatch) || (o.pid as number) < 1) shapeFail();
  return o as unknown as PeerFacts;
}
/** The helper binary is this user's, not group/world-writable, reached by its realpath, with exactly the pinned sha256. */
export async function verifyHelperBinary(path: string, sha256: string): Promise<void> {
  try {
    if (await realpath(path) !== path) throw new PeerError('HELPER');
    const st = await lstat(path);
    if (!st.isFile() || st.uid !== process.getuid!() || (st.mode & 0o022) !== 0) throw new PeerError('HELPER');
    if (createHash('sha256').update(await readFile(path)).digest('hex') !== sha256) throw new PeerError('HELPER');
  } catch { throw new PeerError('HELPER'); }
}
/** Runs the helper on `channel` (an inherited fd number or a child's channel socket); rejects with PeerError('HELPER'). */
export function runPeerHelper(helper: string, channel: number | Socket, expectedExe: string, timeoutMs = 500): Promise<PeerFacts> {
  return new Promise((resolve, reject) => {
    // A Socket given to spawn() as stdio is permanently stopped for reading in this process (Node marks it "used as stdio"),
    // which would silence the channel. Its raw descriptor is passed instead: the helper gets a dup, the stream is untouched.
    const fd = typeof channel === 'number' ? channel : (channel as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
    if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 0) { reject(new PeerError('HELPER')); return; }
    let child;
    try { child = spawn(helper, ['peer'], { stdio: ['ignore', 'pipe', 'ignore', fd, 'pipe'], env: {} }); }
    catch { reject(new PeerError('HELPER')); return; }
    let out = ''; let done = false;
    const finish = (error: Error | null, facts?: PeerFacts) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(facts!); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new PeerError('HELPER')); }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => { out += d; if (out.length > 512) { child.kill('SIGKILL'); finish(new PeerError('HELPER')); } });
    child.on('error', () => finish(new PeerError('HELPER')));
    const path = child.stdio[4] as unknown as NodeJS.WritableStream;
    path.on('error', () => finish(new PeerError('HELPER')));
    path.end(expectedExe);
    child.on('close', code => {
      if (code !== 0) { finish(new PeerError('HELPER')); return; }
      try { finish(null, decodePeerFacts(out)); } catch { finish(new PeerError('HELPER')); }
    });
  });
}
/** Requirements on a proven CHILD peer (S or E): exact pid, parent = this process, same euid, expected exe, no TTY. */
export function childPeerOk(f: PeerFacts, childPid: number): boolean {
  return f.pid === childPid && f.ppid === process.pid && f.euid === process.geteuid!() && f.exeMatch && !f.hasTty;
}
/** Requirements on the proven PARENT peer (O as seen by C): exact parent pid, same euid, expected exe, with a TTY. */
export function parentPeerOk(f: PeerFacts, parentPid: number): boolean {
  return f.pid === parentPid && f.euid === process.geteuid!() && f.exeMatch && f.hasTty;
}
/** The recorded incarnation must stay identical across re-proofs (same pid AND pidversion). */
export const sameIncarnation = (a: PeerFacts, b: PeerFacts): boolean => a.pid === b.pid && a.pidversion === b.pidversion;
