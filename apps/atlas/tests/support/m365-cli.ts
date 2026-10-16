import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { projectRoot } from './pg-harness.ts';
import type { PgTestDatabase } from './pg-harness.ts';
import { WS } from './graph-fixtures.ts';
import { M365_SECRET_VALUE } from './m365-graph-mock.ts';
import { CURSOR_SECRET } from './correlation-fixtures.ts';

/**
 * Actual `scripts/ops.ts` child processes for the S2-C CLI tests, with the TEST-ONLY fetch preload (m365-fetch-preload.ts)
 * answering the fixed token/Graph routes from a scenario file in a private temp directory. The child gets synthetic
 * credentials only: the operator token of a synthetic actor, the synthetic M365 client secret behind env://M365_GASTA, the
 * synthetic cursor secret and (when asked) the disposable database's runner URL. Nothing from the developer's shell.
 */
export interface CliResult { code: number | null; output: Record<string, unknown> }
export interface Cli { dir: string; run(args: string[], env?: Record<string, string>): Promise<CliResult>; start(args: string[], env?: Record<string, string>): Promise<CliResult>;
  scenario(s: Record<string, unknown>): void; calls(): { method: string; path: string }[]; held(): boolean; release(): void; close(): void }

const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined
  && !/^(ATLAS_|OPENAI_|HUNTRESS_|ATERA_|M365_|DATABASE_URL)/.test(e[0])));

/** A synthetic actor with exactly these permissions on Gasta and an API token (digest only stored). */
export async function addOperator(owner: pg.Client, id: string, permissions: string[]): Promise<string> {
  const token = generateToken();
  await owner.query(`INSERT INTO "Actor" ("workspaceId","id","displayName") VALUES ($1,$2,'Synthetic operator') ON CONFLICT DO NOTHING`, [WS, id]);
  await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ($1,'demo-gasta',$2,$3)
    ON CONFLICT ("workspaceId","clientId","actorId") DO UPDATE SET permissions = EXCLUDED.permissions`, [WS, id, permissions]);
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash","label") VALUES ($1,$2,$3,$4,'synthetic')`, [WS, `token-${id}`, id, hashToken(token)]);
  return token;
}

export function cli(pgdb: PgTestDatabase, token: string, base: Record<string, string> = {}): Cli {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-m365-cli-'));
  const env = (extra: Record<string, string>) => ({ ...inherited, ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_OPERATOR_TOKEN: token, ATLAS_TEST_M365_PRELOAD_DIR: dir,
    M365_GASTA: M365_SECRET_VALUE, ATLAS_CORRELATION_CURSOR_SECRET_REF: 'env://ATLAS_TEST_CURSOR_SECRET', ATLAS_TEST_CURSOR_SECRET: CURSOR_SECRET, ...base, ...extra });
  const start = (args: string[], extra: Record<string, string> = {}): Promise<CliResult> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--import', './tests/support/m365-fetch-preload.ts', 'scripts/ops.ts', ...args],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], env: env(extra) });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.once('exit', code => {
      clearTimeout(timer);
      try { resolve({ code, output: JSON.parse(stdout) as Record<string, unknown> }); }
      catch { reject(new Error(`ops ${args[0]} printed no JSON (exit ${code}): ${stderr}`)); }
    });
  });
  return {
    dir, start, run: start,
    scenario: s => writeFileSync(join(dir, 'scenario.json'), JSON.stringify(s)),
    calls: () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    held: () => existsSync(join(dir, 'held')),
    release: () => writeFileSync(join(dir, 'release'), 'go'),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
export async function waitFor(check: () => boolean, ms = 30_000): Promise<void> {
  for (let i = 0; i < ms / 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 50));
  if (!check()) throw new Error('waitFor: condition not reached');
}
