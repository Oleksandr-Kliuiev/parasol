// TEST-ONLY controller entry (R-EVAL RS-A launch test): the production controller with the Docker TCP seam. Its test JSON is
// `<owner config dir>/test.json` (test-only). At first JS entry it probes its inherited descriptors; it then opens SENTINEL
// handles (config, secret, a listening socket, a DB socket) that its children S/E must never inherit (leak test).
import { appendFileSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { probeDescriptors } from './reval-test-deps.ts';
import type { TestTcp } from './reval-test-deps.ts';

const configPath = process.env.ATLAS_REVAL_CONFIG!;
const testJson = join(dirname(configPath), 'test.json');
const t = JSON.parse(readFileSync(testJson, 'utf8')) as TestTcp & { alterPidversionAfter?: number; sentinelFile?: string; secretLog?: string; controllerFdProbe?: string;
  skewAfterStartupWrapperMs?: number;
  /** R1 stall seams on the REAL reader backend: the nth reader connect stalls in its physical step; every IDENTITY recheck stalls. */
  stallConnectCall?: number; stallRecheck?: boolean;
  /** Pre-proof local exits (F3.5): force a non-darwin platform (10) or a TTY-less parent proof (12); record C's exit code. */
  forcePlatform?: string; parentWithoutTty?: boolean; exitCodeFile?: string;
  /** RS-B rc2: the Nth reader snapshot transaction (BEGIN … READ ONLY) waits `stallReaderBeginMs` first. */
  stallReaderBeginNumber?: number; stallReaderBeginMs?: number; stallMarkerFile?: string;
  /** RS-D-B: launch S WITHOUT the Seatbelt profile (C must then refuse it before it listens). */
  noSandbox?: boolean;
  /** RS-D-B rc2 (review F1): log the role name of every configured credential file C ITSELF opens/reads, at the fs level. */
  fsSecretLog?: string };
if (t.controllerFdProbe) writeFileSync(t.controllerFdProbe, JSON.stringify({ role: 'C', pid: process.pid, env: Object.keys(process.env).sort(), fds: probeDescriptors() }));
const { spawn } = await import('node:child_process');
const { createServer, createConnection } = await import('node:net');
const { fstatSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { createController, productionDeps } = await import('../../packages/reval/controller.ts');
const { tcpVerify, TEST_PLATFORM_REF } = await import('./reval-test-deps.ts');
const { APPLICATION_NAME } = await import('../../packages/reval/codes.ts');
const { PHYSICAL_QUERY } = await import('../../packages/reval/physical.ts');
const { bounded } = await import('../../packages/reval/deadline.ts');
const { PROJECT_ROOT, spawnServer } = await import('../../packages/reval/launch.ts');
const { serverSandboxPaths } = await import('../../packages/reval/platform.ts');
const { realpathSync } = await import('node:fs');

// Sentinels held by C at every child spawn.
const sentinels: { kind: string; dev: number; ino: number; port?: number }[] = [];
const hold = (kind: string, fd: number) => { const st = fstatSync(fd); sentinels.push({ kind, dev: st.dev, ino: st.ino }); };
hold('config-file', openSync(configPath, 'r'));
const secretDir = join(dirname(configPath), 'secrets');
hold('secret-file', openSync(join(secretDir, 'reader'), 'r'));
const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
hold('listening-socket', (listener as unknown as { _handle: { fd: number } })._handle.fd);
sentinels[sentinels.length - 1]!.port = (listener.address() as { port: number }).port;
const dbSock = createConnection({ host: t.host, port: t.port }); await new Promise(r => dbSock.once('connect', r));
hold('db-socket', (dbSock as unknown as { _handle: { fd: number } })._handle.fd);
if (t.sentinelFile) writeFileSync(t.sentinelFile, JSON.stringify(sentinels));
// RS-D-B rc2 (review F1): the DI readSecret seam alone missed a direct read (the privacy scanner) — spy on fs itself, after the harness's
// own sentinel opens: every open/read path of C that resolves to a configured credential file is logged by role.
if (t.fsSecretLog) {
  const fsMod = (await import('node:fs')).default; const { syncBuiltinESMExports } = await import('node:module');
  const real = (p: string) => { try { return fsMod.realpathSync(p); } catch { return p; } };
  const files = (JSON.parse(readFileSync(configPath, 'utf8')) as { secretFiles: Record<string, string> }).secretFiles;
  const watched = new Map(Object.entries(files).map(([role, p]) => [real(p), role]));
  const log = t.fsSecretLog;
  const note = (p: unknown) => { const role = typeof p === 'string' || p instanceof URL ? watched.get(real(p instanceof URL ? fileURLToPath(p) : p)) : undefined;
    if (role) appendFileSync(log, `${role}\n`); };
  for (const target of [fsMod, fsMod.promises] as unknown as Record<string, (...a: unknown[]) => unknown>[]) {
    for (const name of ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream']) {
      const orig = target[name]; if (typeof orig !== 'function') continue;
      target[name] = function (this: unknown, p: unknown, ...a: unknown[]) { note(p); return orig.call(this, p, ...a); };
    }
  }
  syncBuiltinESMExports();
}

const serverEntry = fileURLToPath(new URL('./reval-test-server-entry.ts', import.meta.url));
const execEntry = fileURLToPath(new URL('./reval-test-exec-entry.ts', import.meta.url));
const verifierEntry = fileURLToPath(new URL('./reval-test-verifier-entry.ts', import.meta.url));
const base = productionDeps();
let childProofs = 0;
// Test clock skew: after the FIRST snapshot transaction commits (the startup wrapper), C's monotonic clock jumps ahead.
let skew = 0; let commits = 0; let connects = 0; let begins = 0;
const STALL = 'SELECT pg_catalog.pg_sleep(30)';
await createController({
  ...base,
  ...(t.forcePlatform ? { platform: t.forcePlatform } : {}),
  exit: code => { if (t.exitCodeFile) writeFileSync(t.exitCodeFile, String(code)); return base.exit(code); },
  platformRef: TEST_PLATFORM_REF,
  now: () => base.now() + skew,
  readSecret: async path => { if (t.secretLog) appendFileSync(t.secretLog, `${path}\n`); return base.readSecret(path); },
  connectReader: async (config, password, budgetMs) => {
    const r = await tcpVerify(t, config.endpoint, config.physical, config.roles.reader, password, APPLICATION_NAME.reader, budgetMs,
      ++connects === t.stallConnectCall ? STALL : undefined);
    if (t.stallReaderBeginNumber !== undefined) {
      const q0 = r.client.query.bind(r.client);
      r.client.query = async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') && ++begins === t.stallReaderBeginNumber) {
          if (t.stallMarkerFile) writeFileSync(t.stallMarkerFile, 'stalled');
          await new Promise(res => setTimeout(res, t.stallReaderBeginMs ?? 300));
        }
        return q0(sql, params);
      };
    }
    if (t.skewAfterStartupWrapperMs === undefined) return r;
    const query = r.client.query.bind(r.client);
    r.client.query = async (sql: string, params?: unknown[]) => { const out = await query(sql, params); if (sql === 'COMMIT' && ++commits === 1) skew = t.skewAfterStartupWrapperMs!; return out; };
    return r;
  },
  recheckReader: async (config, client, budgetMs) => {
    const until = performance.now() + budgetMs;
    try {
      if (t.stallRecheck) await bounded(client.query(STALL), until);
      const row = (await bounded(client.query(PHYSICAL_QUERY), until)).rows[0];
      return !!row && row.system_identifier === config.physical.systemIdentifier && row.database_oid === config.physical.databaseOid
        && row.start_epoch === config.physical.postmasterStartTime && row.session_user === config.roles.reader;
    } catch { return false; }
  },
  peer: async (helper, channel, exe) => {
    const f = await base.peer(helper, channel, exe);
    if (channel === 3 && t.parentWithoutTty) return { ...f, hasTty: false };
    if (channel !== 3 && t.alterPidversionAfter !== undefined && ++childProofs > t.alterPidversionAfter) return { ...f, pidversion: f.pidversion + 1 };
    return f;
  },
  // RS-D-B: the PRODUCTION launcher — S under the pinned Seatbelt profile (the TCP seam to Docker PG is loopback); `noSandbox` = the refusal test.
  spawnServer: config => t.noSandbox
    ? spawn(process.execPath, [serverEntry, testJson], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      env: { ATLAS_MODE: 'db', ATLAS_API_PORT: String(config.server.port), ATLAS_REVAL_BRIDGE_FD: '3' } })
    : spawnServer(serverEntry, config.server.port, serverSandboxPaths(config, configPath, realpathSync(process.execPath), PROJECT_ROOT), [testJson]),
  spawnExecutor: () => spawn(process.execPath, [execEntry, testJson], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: {} }),
  spawnVerifier: () => spawn(process.execPath, [verifierEntry, testJson], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: {} }),
}).run();
