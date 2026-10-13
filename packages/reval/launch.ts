import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverSandboxArgv } from './platform.ts';
import type { ServerSandboxPaths } from './platform.ts';

/**
 * Launch inputs and DECLARED-set digests (brief §2a/§2d). The child environments and argv are exact allowlists (no URL, no
 * secret, no NODE_OPTIONS/PATH/proxy, no execArgv). The digests are pre-launch measurements of a declared file set: they
 * are neither complete nor immutable, so loadedBinding stays UNVERIFIED (RS-D).
 */
export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PRODUCTION_ENTRIES = Object.freeze({
  controller: join(PROJECT_ROOT, 'scripts/reval-server/controller.ts'),
  executor: join(PROJECT_ROOT, 'scripts/reval-server/owner-exec.ts'),
  verifier: join(PROJECT_ROOT, 'scripts/reval-server/fixture-verifier.ts'),
  api: join(PROJECT_ROOT, 'dist/apps/api/src/main.js'),
});

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function walk(root: string, rel: string, out: string[]): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(root, r, out); else if (e.isFile()) out.push(r);
  }
}
/** Canonical sorted `path\tsha256\n` manifest of the given project-relative files/directories; returns digest and paths. */
export async function manifestOf(root: string, entries: readonly string[]): Promise<{ sha256: string; paths: string[] }> {
  const files: string[] = [];
  for (const e of entries) {
    const st = await readdir(join(root, e)).then(() => 'dir').catch(() => 'file');
    if (st === 'dir') await walk(root, e, files); else files.push(e);
  }
  files.sort();
  const lines: string[] = [];
  for (const f of files) lines.push(`${f}\t${sha(await readFile(join(root, f)))}\n`);
  return { sha256: sha(lines.join('')), paths: files };
}
export interface Digests {
  readonly buildManifestSha256: string; readonly runtimeImageSha256: string; readonly launcherManifestSha256: string;
  /** Realpath of dist/apps/api/src/main.js when it is an entry of the build manifest, else null. */
  readonly apiEntry: string | null;
}
export async function computeDigests(root: string, nodeBinary: string, helperSha256: string): Promise<Digests> {
  // RS-C-C: the sealed measured console that the bridge server serves is part of the measured build (registration/SNAPSHOT bind it).
  const build = await manifestOf(root, ['dist/apps/api', 'dist/packages', 'dist/operator-measured', 'package-lock.json', 'prisma/migrations', 'prisma/roles.sql', 'prisma/roles']);
  const lock = sha(await readFile(join(root, 'package-lock.json')));
  const node = sha(await readFile(nodeBinary));
  const launcher = await manifestOf(root, ['packages/reval', 'scripts/reval-server', 'native/reval-peer/peer.c']);
  const apiRel = 'dist/apps/api/src/main.js';
  const apiEntry = build.paths.includes(apiRel) ? await realpath(join(root, apiRel)).catch(() => null) : null;
  return {
    buildManifestSha256: build.sha256,
    runtimeImageSha256: sha(JSON.stringify({ nodeBinarySha256: node, buildManifestSha256: build.sha256, packageLockSha256: lock })),
    launcherManifestSha256: sha(JSON.stringify({ launcherManifestSha256: launcher.sha256, nativePeerHelperSha256: helperSha256 })),
    apiEntry,
  };
}

const CHILD_STDIO: ['ignore', 'ignore', 'ignore', 'pipe'] = ['ignore', 'ignore', 'ignore', 'pipe'];
/** O → C: detached (setsid: no controlling terminal), env EXACTLY the three launch identifiers. */
export function spawnController(entry: string, env: { config: string; connectionId: string; serverBootId: string }): ChildProcess {
  return spawn(process.execPath, [entry], { detached: true, stdio: CHILD_STDIO,
    env: { ATLAS_REVAL_CONFIG: env.config, ATLAS_REVAL_CONNECTION_ID: env.connectionId, ATLAS_REVAL_SERVER_BOOT_ID: env.serverBootId } });
}
/**
 * C → S: non-detached, env EXACTLY ATLAS_MODE=db, ATLAS_API_PORT and ATLAS_REVAL_BRIDGE_FD=3. RS-D-B: under the pinned Seatbelt profile
 * (platform.ts) — `sandbox-exec` execs `nodeRealpath` in place, so the child pid is S's; S may exec only node and the pinned helper (`paths`).
 */
export function spawnServer(entry: string, port: number, paths: ServerSandboxPaths, args: readonly string[] = []): ChildProcess {
  const { file, argv } = serverSandboxArgv(paths, entry, args);
  return spawn(file, argv, { stdio: CHILD_STDIO, env: { ATLAS_MODE: 'db', ATLAS_API_PORT: String(port), ATLAS_REVAL_BRIDGE_FD: '3' } });
}
/** C → E and C → V (RS-B fixture verifier): env EMPTY. */
export function spawnExecutor(entry: string): ChildProcess {
  return spawn(process.execPath, [entry], { stdio: CHILD_STDIO, env: {} });
}
/** Waits for a child's exit up to `ms`; true when it exited (reaped). */
export function awaitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}
