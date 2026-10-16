import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { openSync, closeSync, realpathSync } from 'node:fs';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import pg from 'pg';
import { APPLICATION_NAME, PRODUCTION_PLATFORM_REF } from './codes.ts';
import { loadOwnerConfig } from './config.ts';
import type { OwnerConfig } from './config.ts';
import { computeDigests, PRODUCTION_ENTRIES, PROJECT_ROOT, spawnExecutor, spawnServer } from './launch.ts';
import type { Digests } from './launch.ts';
import { runPeerHelper, verifyHelperBinary } from './peer.ts';
import { runSandboxCheck, serverSandboxPaths } from './platform.ts';
import type { SandboxFacts } from './platform.ts';
import type { PeerFacts } from './peer.ts';
import { nodePhysicalDeps, recheckPhysical, verifyPhysicalEndpoint } from './physical.ts';
import type { Observed, QueryClient } from './physical.ts';
import { readSecretFile } from './secret-file.ts';

/**
 * Everything the controller touches outside pure logic. productionDeps() is the ONLY set reachable from
 * scripts/reval-server/controller.ts: unix-socket physical binding, the pinned helper, the production child entries and
 * the single production platform reference. Test harnesses build their own sets outside production code.
 */
export interface ControllerDeps {
  readonly platform: string; readonly arch: string; readonly platformRef: string; readonly nodeRealpath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  now(): number; wallIso(): string; ppid(): number; ttyAvailable(): boolean;
  loadConfig(path: string): Promise<OwnerConfig>;
  verifyHelper(path: string, sha256: string): Promise<void>;
  warmHelper(path: string): Promise<void>;
  peer(helper: string, channel: number | Socket, expectedExe: string): Promise<PeerFacts>;
  digests(config: OwnerConfig): Promise<Digests>;
  readSecret(path: string): Promise<Buffer>;
  /** Physical binding + connect of the reader (the ONLY resident credential), all of steps 1–6 within `budgetMs`. */
  connectReader(config: OwnerConfig, password: string, budgetMs: number): Promise<{ client: QueryClient; observed: Observed }>;
  /** Filesystem + database recheck of an open reader connection (EVERY IDENTITY) within `budgetMs`. */
  recheckReader(config: OwnerConfig, client: QueryClient, budgetMs: number): Promise<boolean>;
  spawnServer(config: OwnerConfig, configPath: string): ChildProcess;
  /** RS-D-B: the native helper's Seatbelt answer for a pid (`sandbox <pid>`). */
  sandboxCheck(helper: string, pid: number): Promise<SandboxFacts>;
  spawnExecutor(): ChildProcess;
  /** RS-B: the fixture verifier V, spawned exactly like E (empty env, fd 3 only). */
  spawnVerifier(): ChildProcess;
  ownerSocket(): Duplex;
  exit(code: number): never;
}
const pgConnect = async (o: pg.ClientConfig): Promise<QueryClient> => {
  const client = new pg.Client(o); await client.connect(); return client as unknown as QueryClient;
};
export function productionDeps(): ControllerDeps {
  const physical = nodePhysicalDeps(o => pgConnect(o));
  const expectation = (config: OwnerConfig, budgetMs: number) => ({ endpoint: config.endpoint, physical: config.physical, role: config.roles.reader,
    applicationName: APPLICATION_NAME.reader, budgetMs });
  return {
    platform: process.platform, arch: process.arch, platformRef: PRODUCTION_PLATFORM_REF, nodeRealpath: realpathSync(process.execPath),
    env: process.env,
    now: () => performance.now(), wallIso: () => new Date().toISOString(), ppid: () => process.ppid,
    ttyAvailable: () => { try { closeSync(openSync('/dev/tty', 'r')); return true; } catch { return false; } },
    loadConfig: loadOwnerConfig, verifyHelper: verifyHelperBinary,
    warmHelper: path => new Promise((resolve, reject) => {
      // First exec of a freshly signed binary is assessed by the OS; a no-channel run exits 65 by contract.
      const child = spawn(path, ['peer'], { stdio: 'ignore', env: {} });
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('warm')); }, 5000);
      child.on('exit', code => { clearTimeout(t); code === 65 ? resolve() : reject(new Error('warm')); });
      child.on('error', () => { clearTimeout(t); reject(new Error('warm')); });
    }),
    peer: (helper, channel, exe) => runPeerHelper(helper, channel, exe),
    digests: config => computeDigests(PROJECT_ROOT, realpathSync(process.execPath), config.nativePeerHelperSha256),
    readSecret: readSecretFile,
    connectReader: (config, password, budgetMs) => verifyPhysicalEndpoint(expectation(config, budgetMs), password, physical),
    recheckReader: (config, client, budgetMs) => recheckPhysical(expectation(config, budgetMs), client, physical),
    spawnServer: (config, configPath) => spawnServer(config.server.apiEntry, config.server.port, serverSandboxPaths(config, configPath, realpathSync(process.execPath), PROJECT_ROOT)),
    sandboxCheck: (helper, pid) => runSandboxCheck(helper, pid),
    spawnExecutor: () => spawnExecutor(PRODUCTION_ENTRIES.executor),
    spawnVerifier: () => spawnExecutor(PRODUCTION_ENTRIES.verifier),
    ownerSocket: () => new Socket({ fd: 3, readable: true, writable: true }),
    exit: code => process.exit(code),
  };
}
