import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASK_REMOTE_PROFILE } from '../../packages/ask/remote/budget.ts';
import { Channel } from '../../packages/reval/channel.ts';
import type { Operation } from '../../packages/reval/codes.ts';
import { createController } from '../../packages/reval/controller.ts';
import type { ControllerDeps } from '../../packages/reval/deps.ts';
import { buildRequest, checkResponse, decodeResponse, Sequence } from '../../packages/reval/envelope.ts';
import type { Response } from '../../packages/reval/envelope.ts';
import { METADATA_FRAME_CAP } from '../../packages/reval/frame.ts';
import type { QueryClient } from '../../packages/reval/physical.ts';

/**
 * TEST-ONLY in-process harness for the REAL controller (no DB, no helper): a real AF_UNIX socket pair carries O's frames,
 * the O side validates every response exactly like the production owner CLI (checkResponse: binding, next sequence,
 * challenge, instance, emitter), and every dependency is a spy. Pre-proof gates pass with synthetic facts; the stubs decide
 * what stalls. Never imported by production code.
 */
export const PHYSICAL = { systemIdentifier: '1', databaseOid: '2', postmasterStartTime: '3', postmasterPid: '4', dataDirectory: '/d', socketDevice: '5', socketInode: '6' };
export interface Ids { reg: string; inst: string; adm: string; boot: string; conn: string }
/** A schema- and relation-valid internal wrapper with `n` registered SETTLED NO_DISPATCH attempts (n = 700 exceeds 256 KiB). */
export function wrapperOf(ids: Ids, n: number): Record<string, unknown> {
  const now = new Date(); const day = now.toISOString().slice(0, 10); const month = `${day.slice(0, 7)}-01`;
  const base = Date.parse(`${day}T00:00:00.000Z`);
  const attempts = Array.from({ length: n }, () => randomUUID()).sort().map((id, i) => ({ attemptId: id, correlationId: randomUUID(), admissionId: ids.adm,
    policyVersion: '1', createdAt: new Date(base + i).toISOString(), dayStart: day, monthStart: month, reservedMicroUsd: '300000', accountedMicroUsd: '0',
    state: 'SETTLED', outcome: 'NO_DISPATCH', settledAt: new Date(base + i).toISOString() }));
  return { registrationId: ids.reg, databaseInstanceId: ids.inst, buildManifestSha256: 'a'.repeat(64), systemIdentifier: '1', databaseOid: '2', postmasterStartTime: '3',
    pricing: { policy: { profile: ASK_REMOTE_PROFILE, priceRevision: 'rev-1', reserveMicroUsd: '300000' },
      attempts: n === 0 ? [] : [{ profile: ASK_REMOTE_PROFILE, priceRevision: 'rev-1', reservedMicroUsd: '300000', promptRate: '275', completionRate: '825' }] },
    snapshot: { dbObservedAt: now.toISOString(), admissionId: ids.adm, policyVersion: '1', fenceEpoch: '1', policyState: 'ACTIVE', reserveMicroUsd: '300000',
      dayCapMicroUsd: '1000000', monthCapMicroUsd: '5000000', expiresAt: now.toISOString(), currentDay: day, currentMonth: month, fixtureGeneration: '1',
      fixtureId: 'FX01', projectAttemptCount: String(n), foreignScopeAttemptCount: '0',
      periods: [{ kind: 'MONTH', periodStart: month, chargedMicroUsd: '0', attemptCount: String(n) }, { kind: 'DAY', periodStart: day, chargedMicroUsd: '0', attemptCount: String(n) }],
      attempts, consistent: true } };
}
/** A stub reader client: snapshot rows from `wrapper()`, every other statement empty; records end/destroy. */
export interface StubClient extends QueryClient { ended: boolean; destroyed: boolean; statements: string[] }
export function stubClient(wrapper: () => Record<string, unknown>): StubClient {
  const c: StubClient = { ended: false, destroyed: false, statements: [],
    query: async (sql: string) => { c.statements.push(sql); return { rows: sql.includes('atlas_reval_snapshot') ? [{ w: wrapper() }] : [] }; },
    end: async () => { c.ended = true; } };
  Object.defineProperty(c, 'connection', { value: { stream: { destroy: () => { c.destroyed = true; } } } });
  return c;
}
export interface Harness {
  readonly ids: Ids;
  /** Sends one request and awaits its response (≤ 2500 ms), validated as O does. */
  request(op: Operation, payload?: Record<string, unknown>): Promise<{ r: Response | null; ms: number; problem: string | null }>;
  /** O's end closes (EOF at C). */
  eof(): void;
  readonly exited: Promise<number>;
  readonly events: string[];
  readonly children: ChildProcess[];
  cleanup(): void;
}
export async function controllerHarness(over: (ids: Ids, events: string[], children: ChildProcess[]) => Partial<ControllerDeps>, mode: 'NONE' | 'LAUNCH' = 'NONE'): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'reval-ch-')); const path = join(dir, 's');
  const srv = createServer(); await new Promise<void>(r => srv.listen(path, r));
  const cSide = new Promise<Socket>(r => srv.once('connection', r));
  const oSock = connect(path); const cSock = await cSide;
  const ids: Ids = { reg: randomUUID(), inst: randomUUID(), adm: randomUUID(), boot: randomUUID(), conn: randomUUID() };
  const events: string[] = []; const children: ChildProcess[] = [];
  let exit!: (c: number) => void; const exited = new Promise<number>(r => { exit = r; });
  const config = { contractVersion: 'RevalOwnerConfigV1', registrationId: ids.reg, databaseInstanceId: ids.inst, workspaceId: 'ws', clientId: 'cl', actorId: 'ac',
    admissionId: ids.adm, approvedPriceRevision: 'rev-1', nativePeerHelper: '/h', nativePeerHelperSha256: 'b'.repeat(64),
    endpoint: { socketDir: '/s', port: 5432, database: 'db' }, roles: { reader: 'r', runtime: 'u', owner: 'o' }, physical: PHYSICAL,
    secretFiles: { reader: '/a', runtime: '/b', owner: '/c' }, server: { mode, apiEntry: '/x', port: 3999 } };
  const deps = { platform: 'darwin', arch: 'arm64', platformRef: 'ref', nodeRealpath: '/n',
    env: { ATLAS_REVAL_CONFIG: '/cfg/c.json', ATLAS_REVAL_CONNECTION_ID: ids.conn, ATLAS_REVAL_SERVER_BOOT_ID: ids.boot },
    now: () => performance.now(), wallIso: () => new Date().toISOString(), ppid: () => 1, ttyAvailable: () => false,
    loadConfig: async () => config, verifyHelper: async () => undefined, warmHelper: async () => undefined,
    peer: async () => ({ pid: 1, pidversion: 1, euid: process.geteuid!(), ppid: 0, startSec: 1, startUsec: 0, hasTty: true, exeMatch: true }),
    digests: async () => ({ buildManifestSha256: 'a'.repeat(64), runtimeImageSha256: 'c'.repeat(64), launcherManifestSha256: 'd'.repeat(64), apiEntry: '/x' }),
    readSecret: async () => Buffer.from('reader-only-password'),
    connectReader: async () => ({ client: stubClient(() => wrapperOf(ids, 1)), observed: {} }), recheckReader: async () => true,
    spawnServer: () => { events.push('spawnServer'); throw new Error('no S'); }, spawnExecutor: () => { events.push('spawnExecutor'); throw new Error('no E'); },
    ownerSocket: () => cSock, exit: (c: number) => { events.push(`exit ${c}`); exit(c); return undefined as never; },
    ...over(ids, events, children) } as unknown as ControllerDeps;
  void createController(deps).run();
  const ch = new Channel(oSock, METADATA_FRAME_CAP);
  const binding = { registrationId: ids.reg, serverBootId: ids.boot, connectionId: ids.conn };
  const send = new Sequence(); const recv = new Sequence();
  return {
    ids, events, children, exited,
    request: async (op, payload = {}) => {
      const out = { challenge: randomUUID(), sequence: send.take(), operation: op };
      const t = performance.now();
      ch.send(buildRequest(binding, out.challenge, out.sequence, op, payload));
      try {
        const r = decodeResponse(await ch.next(2500));
        return { r, ms: performance.now() - t, problem: checkResponse(binding, recv, out, r, 'CONTROLLER', ids.inst) };
      } catch (e) { return { r: null, ms: performance.now() - t, problem: (e as Error).message }; }
    },
    eof: () => { oSock.end(); oSock.destroy(); },
    cleanup: () => { oSock.destroy(); srv.close(); for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); },
  };
}
/** A REAL child that never writes HELLO (stands in for S): proves the controller kills/reaps it. */
export function silentChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
}
export const alive = (p: ChildProcess): boolean => p.exitCode === null && p.signalCode === null;
