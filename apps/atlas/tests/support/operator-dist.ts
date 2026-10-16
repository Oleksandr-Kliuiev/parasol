import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from './pg-harness.ts';
import { freePort } from './api-process.ts';

// A private copy of the compiled API for operator-console startup cases (tests/pg/operator-http.pg.test.ts): the shared
// dist/ is never renamed or edited, so concurrent checks are unaffected. node_modules is linked, package.json copied
// (ESM type), and dist/operator is included or left out per case.

export interface StagedDist { root: string; main: string; operator: string; remove(): Promise<void> }
export async function stageDist(withOperator: boolean): Promise<StagedDist> {
  const root = await mkdtemp(join(tmpdir(), 'atlas-operator-dist-'));
  for (const part of ['apps', 'packages', 'connectors', 'fixtures']) await cp(join(projectRoot, 'dist', part), join(root, 'dist', part), { recursive: true });
  if (withOperator) await cp(join(projectRoot, 'dist', 'operator'), join(root, 'dist', 'operator'), { recursive: true });
  await copyFile(join(projectRoot, 'package.json'), join(root, 'package.json'));
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  return { root, main: join(root, 'dist/apps/api/src/main.js'), operator: join(root, 'dist/operator'), remove: () => rm(root, { recursive: true, force: true }) };
}

export interface Started { base: string; port: number; stop(): Promise<void> }
export type Outcome = { started: Started } | { exitCode: number | null; stderr: string };

/** Starts a compiled main.js with exactly `env` added, from `cwd`; resolves when it answers HTTP or exits. */
export async function runMain(main: string, env: Record<string, string>, cwd: string, unset: string[] = []): Promise<Outcome> {
  const port = await freePort();
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env, ATLAS_API_PORT: String(port) };
  for (const name of unset) delete childEnv[name];
  const child = spawn(process.execPath, [main], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  const stop = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } };
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) return { exitCode: child.exitCode, stderr };
    try { await fetch(`${base}/clients`); return { started: { base, port, stop } }; } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await stop();
  return { exitCode: null, stderr: `${stderr}\n(did not become ready)` };
}
