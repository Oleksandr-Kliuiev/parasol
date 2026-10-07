import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { projectRoot } from './pg-harness.ts';

/** The compiled API (npm run api:build) as a child process on a free loopback port. Used by tests/pg/api.pg.test.ts. */
const MAIN = 'dist/apps/api/src/main.js';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')));
    });
  });
}

export interface ApiProcess { base: string; stop(): Promise<void> }

/** Starts the API and waits until it answers HTTP (any status). Throws with bounded stderr if it exits first. */
export async function startApi(env: Record<string, string>): Promise<ApiProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, [MAIN], { cwd: projectRoot, env: { ...process.env, ...env, ATLAS_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise<void>(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`API exited ${child.exitCode}: ${stderr}`);
    try { await fetch(`${base}/clients`); return { base, stop }; } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await stop();
  throw new Error(`API did not become ready: ${stderr}`);
}

/** Runs the API expecting it to refuse to start; resolves with its exit code and stderr. */
export async function startApiExpectingRefusal(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, [MAIN], { cwd: projectRoot, env: { ...process.env, ...env, ATLAS_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise<number | null>(resolve => child.once('exit', c => resolve(c)));
  clearTimeout(timer);
  return { code, stderr };
}
