import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from './pg-harness.ts';
import { freePort } from './api-process.ts';

/**
 * S4-C TRUSTED TEST SUPPORT: actual child processes (the compiled DB-mode API and scripts/ops.ts) under the test-only
 * outbound network trap (poweroffice-net-trap.ts), with a clean environment — nothing from the developer's shell besides
 * PATH-like basics — so every credential the child holds is synthetic. stdout/stderr are captured in full for privacy
 * assertions; the trap file must stay empty. A control child proves the trap records real attempts.
 */
const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined
  && !/^(ATLAS_|OPENAI_|HUNTRESS_|ATERA_|M365_|DATABASE_URL|PG)/.test(e[0])));
const PRELOAD = ['--experimental-strip-types', '--import', './tests/support/poweroffice-net-trap.ts'];

export interface Captured { stdout: string; stderr: string }
export interface TrapDir { dir: string; trapFile: string; trapped(): string; close(): void }
export function trapDir(): TrapDir {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-s4c-'));
  const trapFile = join(dir, 'network-trap.log');
  return { dir, trapFile, trapped: () => (existsSync(trapFile) ? readFileSync(trapFile, 'utf8') : ''), close: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface CliRun extends Captured { code: number | null; output: Record<string, unknown> }
/** One actual `scripts/ops.ts` process (token only from its environment, never argv). */
export function runOps(trap: TrapDir, args: string[], env: Record<string, string>): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    // The only permitted socket target: the paired database endpoint of this child's runtime URL (never printed).
    const db = env.ATLAS_RUNTIME_DATABASE_URL ? new URL(env.ATLAS_RUNTIME_DATABASE_URL) : null;
    const endpoint = db ? { ATLAS_TEST_NETWORK_TRAP_DB: `${db.hostname}:${db.port || '5432'}` } : {};
    const child = spawn(process.execPath, [...PRELOAD, 'scripts/ops.ts', ...args], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...inherited, ATLAS_TEST_NETWORK_TRAP_FILE: trap.trapFile, ...endpoint, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += String(d); }); child.stderr.on('data', d => { stderr += String(d); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.once('exit', code => {
      clearTimeout(timer);
      try { resolve({ code, output: JSON.parse(stdout) as Record<string, unknown>, stdout, stderr }); }
      catch { reject(new Error(`ops ${args[0]} printed no JSON (exit ${code})`)); }
    });
  });
}

export interface ApiRun { base: string; captured: Captured; stop(): Promise<void> }
/** The compiled API (npm run api:build) in DB mode under the trap; ready when it answers HTTP. */
export async function startTrappedApi(trap: TrapDir, env: Record<string, string>): Promise<ApiRun> {
  const port = await freePort();
  const child = spawn(process.execPath, [...PRELOAD, 'dist/apps/api/src/main.js'], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, ATLAS_TEST_NETWORK_TRAP_FILE: trap.trapFile, ATLAS_MODE: 'db', ...env, ATLAS_API_PORT: String(port) } });
  const captured: Captured = { stdout: '', stderr: '' };
  child.stdout.on('data', d => { captured.stdout += String(d); }); child.stderr.on('data', d => { captured.stderr += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise<void>(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); child.kill('SIGTERM'); });
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`API exited ${child.exitCode}`);
    try { await fetch(`${base}/clients`); return { base, captured, stop }; } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await stop();
  throw new Error('API did not become ready');
}

/** Positive self-control: the same preload in a child that DOES attempt outbound access records it. */
export function trapControl(trap: TrapDir, env: Record<string, string> = {}): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...PRELOAD, '--input-type=module', '-e',
      `try { await fetch('http://192.0.2.1/'); } catch {} try { (await import('node:net')).default.connect(9, '192.0.2.1'); } catch {} try { new (await import('node:net')).default.Socket().connect(9, '192.0.2.1'); } catch {}`],
    { cwd: projectRoot, stdio: 'ignore', env: { ...inherited, ATLAS_TEST_NETWORK_TRAP_FILE: trap.trapFile, ...env } });
    child.once('exit', () => resolve(trap.trapped()));
  });
}
