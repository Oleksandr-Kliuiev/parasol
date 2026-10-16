import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { readdirSync, fstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { OwnerConfig } from '../../packages/reval/config.ts';
import { bounded, DeadlineExceeded } from '../../packages/reval/deadline.ts';
import { connectFailure, destroyClient, PHYSICAL_QUERY, PhysicalMismatchError } from '../../packages/reval/physical.ts';
import type { Observed, QueryClient } from '../../packages/reval/physical.ts';
import type { Endpoint, PhysicalTuple } from '../../packages/reval/private-frames.ts';

/**
 * TEST-ONLY dependency seam for R-EVAL RS-A (never imported by production; a static test enforces it). Docker PG17 is reached
 * over TCP, so the filesystem/unix-socket half of the physical binding cannot run: these stand-ins compare only the database
 * facts and report the test-only ref `rsa-test-tcp-unverified-v1`. Docker results are regression evidence, never MEASURED;
 * the real unix-socket binding is covered by the native production-chain test.
 */
export const TEST_PLATFORM_REF = 'rsa-test-tcp-unverified-v1';
/** Test-only knobs, written to a 0600 JSON file next to the owner config (never read by production code). */
export interface TestTcp {
  readonly host: string; readonly port: number;
  readonly hooks?: { skipScope?: boolean; reviseZeroRows?: boolean; argDifference?: boolean; activeNoop?: boolean; rollbackBeforeCommit?: boolean;
    ackLostAfterCommit?: boolean; killAfterCommitSent?: boolean; blackholePort?: number; sleepInTxMs?: number;
    /** RS-B: the verifier V sleeps this long after its physical connect (a concurrent binding change lands in between). */
    verifierSleepMs?: number;
    /** RS-C-A (RS-B N3): V writes this marker file when its sleep starts (the test synchronises on it, no activity polling). */
    verifierMarkerFile?: string;
    /** RS-C-A (RS-B N1/P1): V connects as this role (the table owner) with `<config dir>/secrets/owner` — must be refused. */
    verifierRole?: string;
    /** RS-C-A (RS-B N1/P2): V's first source-read statement is preceded by a pg_sleep cancelled server-side (57014) after 50 ms. */
    verifierStallSourceRead?: boolean };
  /** Statement-capture seam: E appends the names of executed statements (and checks rows for leaked values). */
  readonly captureFile?: string;
  /** First-JS-entry descriptor probe output (leak test). */
  readonly fdProbeFile?: string;
  /** Isolated physical-binding controls: S or E connects to ANOTHER otherwise-ready database with the unchanged expectation. */
  readonly serverDatabase?: string; readonly execDatabase?: string;
  /** S reports a forged Bound.observed databaseOid (differs from the reader's tuple). */
  readonly forgeObservedOid?: string;
  /** Internal: the database tcpVerify actually connects to (set from serverDatabase/execDatabase by the entries). */
  readonly databaseOverride?: string;
}
export async function tcpConnect(t: TestTcp, database: string, user: string, password: string, applicationName: string, timeoutMs: number,
  connectTimeoutMs = timeoutMs, types?: pg.CustomTypesConfig): Promise<QueryClient> {
  const c = new pg.Client({ host: t.host, port: t.port, database, user, password, application_name: applicationName, connectionTimeoutMillis: connectTimeoutMs,
    statement_timeout: timeoutMs, ...(types ? { types } : {}) });
  await c.connect(); return c as unknown as QueryClient;
}
/**
 * Database half of the physical comparison over TCP (test-only), mirroring production verifyPhysicalEndpoint: ONE budget for
 * connect + query (session statement_timeout = budget, late client destroyed), credential refusals keep only their SQLSTATE,
 * and system identifier, database OID, start epoch (equal), role and database must match. `stallSql` (test-only) runs on the
 * real backend before the physical query to model a stalled physical binding. `connectTimeoutMs` mirrors the production fixed
 * connection cap (E: min(300, remaining)) — the connect step never gets more, whatever the overall budget.
 */
export async function tcpVerify(t: TestTcp, endpoint: Endpoint, physical: PhysicalTuple, role: string, password: string, applicationName: string, timeoutMs = 1000,
  stallSql?: string, connectTimeoutMs?: number, types?: pg.CustomTypesConfig): Promise<{ client: QueryClient; observed: Observed }> {
  const until = performance.now() + timeoutMs;
  const connectMs = Math.max(1, Math.min(timeoutMs, connectTimeoutMs ?? timeoutMs));
  const client = await bounded(tcpConnect(t, t.databaseOverride ?? endpoint.database, role, password, applicationName, timeoutMs, connectMs, types)
    .catch((e: unknown) => { throw connectFailure(e); }), performance.now() + connectMs, late => { void destroyClient(late); });
  try {
    if (stallSql) await bounded(client.query(stallSql), until);
    const row = (await bounded(client.query(PHYSICAL_QUERY), until)).rows[0]!;
    if (row.system_identifier !== physical.systemIdentifier || row.database_oid !== physical.databaseOid || row.start_epoch !== physical.postmasterStartTime
      || row.session_user !== role || row.database !== endpoint.database) throw new PhysicalMismatchError('database');
    // unixSocket is a schema constant of the private Bound frame; over Docker TCP it is a TEST STUB, never evidence.
    return { client, observed: { systemIdentifier: row.system_identifier as string, databaseOid: row.database_oid as string, postmasterStartTime: row.start_epoch as string,
      backendPid: row.backend_pid as string, sessionUser: row.session_user as string, unixSocket: true } };
  } catch (error) {
    await destroyClient(client);
    throw error instanceof PhysicalMismatchError || error instanceof DeadlineExceeded ? error : new PhysicalMismatchError('database');
  }
}
/** The Docker database's physical facts as a tuple (fs fields are placeholders: the TCP seam never checks them). */
export async function dockerPhysical(admin: pg.Client): Promise<PhysicalTuple> {
  const r = (await admin.query(`${PHYSICAL_QUERY}`)).rows[0];
  return { systemIdentifier: r.system_identifier, databaseOid: r.database_oid, postmasterStartTime: r.start_epoch, postmasterPid: '1', dataDirectory: '/docker-test-only',
    socketDevice: '0', socketInode: '0' };
}
/** A realpath 0700 directory (macOS /tmp and /var are symlinks; the no-symlink rules must not be bypassed). */
export async function privateDir(label: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `reval-${label}-`)));
  await chmod(dir, 0o700); return dir;
}
export async function writePrivate(dir: string, name: string, content: string): Promise<string> {
  const p = join(dir, name); await writeFile(p, content, { mode: 0o600 }); await chmod(p, 0o600); return p;
}
/** Writes the closed owner config plus its three closed password files into `dir`. */
export async function writeOwnerConfig(dir: string, base: Omit<OwnerConfig, 'secretFiles'>, passwords: { reader: string; runtime: string; owner: string }): Promise<{ path: string; config: OwnerConfig }> {
  await mkdir(join(dir, 'secrets'), { mode: 0o700 });
  const secretFiles = { reader: await writePrivate(join(dir, 'secrets'), 'reader', `${passwords.reader}\n`), runtime: await writePrivate(join(dir, 'secrets'), 'runtime', `${passwords.runtime}\n`),
    owner: await writePrivate(join(dir, 'secrets'), 'owner', `${passwords.owner}\n`) };
  const config: OwnerConfig = { ...base, secretFiles };
  return { path: await writePrivate(dir, 'config.json', JSON.stringify(config)), config };
}
/** First-JS-entry descriptor inventory: every open fd with its fstat identity (leak test). */
export function probeDescriptors(): { fd: number; dev: number; ino: number; mode: number; type: string }[] {
  const out = [];
  for (const name of readdirSync('/dev/fd')) {
    const fd = Number(name);
    try {
      const st = fstatSync(fd);
      out.push({ fd, dev: st.dev, ino: st.ino, mode: st.mode, type: st.isSocket() ? 'socket' : st.isFIFO() ? 'fifo' : st.isFile() ? 'file' : st.isCharacterDevice() ? 'char' : st.isDirectory() ? 'dir' : 'other' });
    } catch { /* the readdir handle itself */ }
  }
  return out;
}
export const NODE_REALPATH = realpathSync(process.execPath);
