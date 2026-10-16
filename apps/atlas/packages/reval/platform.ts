import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APPLICATION_NAME } from './codes.ts';
import type { OwnerConfig } from './config.ts';
import { bounded } from './deadline.ts';
import { NO_POLICY_REF, platformVerifiedZero, SERVER_POLICY_REF } from './proof-payloads.ts';
import type { PlatformProof } from './proof-payloads.ts';
import { decodePlatformProof } from './proof-payloads.ts';
import type { QueryClient } from './physical.ts';
import { exact, isBool, req, shapeFail } from './scalars.ts';

/**
 * RS-D-B platform layer of the bridge server S on darwin/arm64 (rs-d brief B §1–§3). C launches S under a PINNED Seatbelt profile
 * (`/usr/bin/sandbox-exec`, the exec keeps S's pid): every IP destination except localhost is denied; outbound unix sockets only to
 * the registered PG socket file itself (RS-D-C: an exact path literal, not its directory; no Docker/other local daemon socket); the system DNS resolver socket denied (the inventory has no
 * DNS); S may exec only node and the pinned native helper (its per-connection peer proof); S can neither read the owner/reader
 * credential files directly nor write the project tree, the helper, any credential file, the owner config file, C's journal or C's
 * instrument socket, nor rename/remove any directory above one of them (RS-D-B rc2 N1/N2; RS-D-C N3, rc2/rc3 F4/F5: a literal deny alone
 * was bypassable by a directory rename); hard-linking a protected file is refused as well (measured). Seatbelt is inherited, so every
 * descendant of S is under the same profile, kernel-enforced, for its whole life. C proves it from outside with the helper's closed
 * `sandbox <pid>` mode (libsystem_sandbox sandbox_check: sandboxed, resolver denied). Seatbelt network denials are not countable here:
 * destination coverage stays UNKNOWN and no proof on this platform can be a verified zero.
 * LIMIT (rc3, review F5, owner decision): the profile is an egress floor plus direct-path denies under `(allow default)`, NOT the
 * containment of a compromised S. S still runs as the same uid and can write every other file of that user, including files that
 * unsandboxed components execute later (the user-owned node toolchain and its libraries, shell/launchd startup files). Closing that
 * needs an allow-list write profile, protected toolchain prefixes or a separate uid for S.
 */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** The system DNS resolver's local socket (getaddrinfo → mDNSResponder); the profile denies it, the helper checks that deny. */
export const RESOLVER_SOCKET = '/private/var/run/mDNSResponder';
const SAFE_PATH = /^\/[A-Za-z0-9._/@+-]+$/;
const safe = (p: string): string => { if (!SAFE_PATH.test(p) || p.includes('//') || p.includes('/../') || p.endsWith('/..') || p.endsWith('/')) throw new Error('SANDBOX_PATH'); return p; };
/** The registration's paths the profile names — realpaths where they exist (Seatbelt matches resolved paths: /var → /private/var). */
export interface ServerSandboxPaths {
  readonly node: string; readonly helper: string; readonly pgSocket: string; readonly readDenied: readonly string[]; readonly writeDenied: readonly string[];
}
/** C's files next to the owner config that S must never write (rc2-N3 of RS-D-B): C's journal and C's instrument socket. */
const C_OWNED = ['reval-journal.jsonl', 'reval-instrument.sock'];
export function serverSandboxPaths(config: OwnerConfig, configPath: string, nodeRealpath: string, projectRoot: string): ServerSandboxPaths {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const f = config.secretFiles; const dir = real(dirname(configPath)); const root = real(projectRoot);
  const files = [real(config.nativePeerHelper), real(f.owner), real(f.reader), real(f.runtime), real(configPath), ...C_OWNED.map(n => join(dir, n))];
  // RS-D-C rc2/rc3 (review F4/F5): a literal path deny alone is bypassed by renaming a directory above the path and reading or writing
  // through the new name, so every ancestor (but `/`) of every named file and of the project root is rename/remove-protected too. The
  // project tree's own subpath rule already covers the ancestors inside it. Creating entries inside a protected directory (S's own
  // socket in the config directory) still works.
  const inTree = (p: string) => p === root || p.startsWith(`${root}/`);
  const ancestors = new Set<string>();
  for (const p of [root, ...files]) for (let a = dirname(p); a !== '/' && a !== '.'; a = dirname(a)) if (!inTree(a)) ancestors.add(a);
  return { node: nodeRealpath, helper: real(config.nativePeerHelper), pgSocket: `${real(config.endpoint.socketDir)}/.s.PGSQL.${config.endpoint.port}`,
    readDenied: [real(f.owner), real(f.reader)], writeDenied: [root, ...files, ...ancestors] };
}
const literals = (ps: readonly string[]) => ps.map(p => `(literal "${safe(p)}")`).join(' ');
/** The pinned profile text (later rules win: the resolver deny stays after the PG socket allow). */
export function serverSandboxProfile(p: ServerSandboxPaths): string {
  const [root, ...files] = p.writeDenied;
  if (root === undefined || p.readDenied.length === 0) throw new Error('SANDBOX_PATH');
  return ['(version 1)', '(allow default)', '(deny network-outbound (remote ip))', '(allow network-outbound (remote ip "localhost:*"))',
    '(deny network-outbound (remote unix-socket))', `(allow network-outbound (remote unix-socket (path-literal "${safe(p.pgSocket)}")))`,
    `(deny network-outbound (literal "${RESOLVER_SOCKET}"))`, `(deny file-read* ${literals(p.readDenied)})`,
    `(deny file-write* (subpath "${safe(root)}") ${literals(files)})`, '(deny process-exec)',
    `(allow process-exec ${literals([p.node, p.helper])})`].join('\n');
}
/** `sandbox-exec -p <profile> <node> <entry> …args`: the file and argv C spawns for S (env and stdio are the caller's exact allowlists). */
export function serverSandboxArgv(p: ServerSandboxPaths, entry: string, args: readonly string[] = []): { file: string; argv: string[] } {
  return { file: SANDBOX_EXEC, argv: ['-p', serverSandboxProfile(p), p.node, entry, ...args] };
}

export interface SandboxFacts { readonly pid: number; readonly sandboxed: boolean; readonly resolverDenied: boolean }
export function decodeSandboxFacts(text: string): SandboxFacts {
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) shapeFail();
  const o = exact(JSON.parse(text), ['pid', 'sandboxed', 'resolverDenied']);
  if (typeof o.pid !== 'number' || !Number.isSafeInteger(o.pid) || o.pid <= 0) shapeFail();
  req(isBool, o.sandboxed); req(isBool, o.resolverDenied);
  return o as unknown as SandboxFacts;
}
/** The helper's `sandbox <pid>` answer (empty env, no fd); any failure rejects. */
export function runSandboxCheck(helper: string, pid: number, timeoutMs = 500): Promise<SandboxFacts> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['sandbox', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], env: {} });
    let out = ''; let done = false;
    const finish = (e: Error | null, v?: SandboxFacts) => { if (done) return; done = true; clearTimeout(timer); if (e) reject(e); else resolve(v!); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('SANDBOX_CHECK_TIMEOUT')); }, timeoutMs);
    child.stdout!.on('data', (b: Buffer) => { out += b.toString('utf8'); if (out.length > 256) child.kill('SIGKILL'); });
    child.once('error', () => finish(new Error('SANDBOX_CHECK')));
    child.once('close', code => {
      if (code !== 0) return finish(new Error('SANDBOX_CHECK'));
      try { const f = decodeSandboxFacts(out); if (f.pid !== pid) throw new Error('pid'); finish(null, f); } catch { finish(new Error('SANDBOX_CHECK')); }
    });
  });
}
/** S is enforced: the answer is for S's own pid, sandboxed, the profile's resolver deny present. */
export const sandboxEnforced = (f: SandboxFacts | null, pid: number | null): boolean => f !== null && pid !== null && f.pid === pid && f.sandboxed && f.resolverDenied;

/**
 * Independent DB process inventory (02 "complete process inventory", rs-d brief B §2.2): every backend of the registered database is S's
 * runtime session or C's reader session (usename, application_name and pid are visible to the non-privileged reader). Autovacuum
 * excluded as in RS-B. Anything else — the owner, the verifier, a foreign login, an unnamed session — is INCOMPLETE.
 */
export async function dbInventory(reader: QueryClient, roles: { readonly runtime: string; readonly reader: string }): Promise<'COMPLETE' | 'INCOMPLETE'> {
  const n = (await reader.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity a
    WHERE a.datid = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
      AND NOT (a.backend_type IS NOT DISTINCT FROM 'autovacuum worker' OR (a.backend_type IS NULL AND a.usesysid IS NULL))
      AND NOT ((a.usename = $1 AND a.application_name = $2) OR (a.usename = $3 AND a.application_name = $4))`,
  [roles.runtime, APPLICATION_NAME.runtime, roles.reader, APPLICATION_NAME.reader])).rows[0]!.n as number;
  return n === 0 ? 'COMPLETE' : 'INCOMPLETE';
}

/**
 * C's DRAIN process inventory (rs-d brief B §2.2): S enforced NOW (sandboxed with the profile's resolver deny, the verified live
 * incarnation) AND every backend of the registered DB S's or C's, by the absolute `deadline`. Any failure, stall or missing piece is
 * INCOMPLETE — never a zero (02).
 */
export async function processInventory(o: { server: { enforcedNow(): Promise<boolean> } | null; reader(): Promise<QueryClient | null>;
  roles: { readonly runtime: string; readonly reader: string }; deadline: number }): Promise<'COMPLETE' | 'INCOMPLETE'> {
  if (!o.server || !await bounded(o.server.enforcedNow(), o.deadline).catch(() => false)) return 'INCOMPLETE';
  const rd = await bounded(o.reader(), o.deadline).catch(() => null);
  if (!rd) return 'INCOMPLETE';
  return bounded(dbInventory(rd, o.roles), o.deadline).catch(() => 'INCOMPLETE' as const);
}

/** The approved network destination inventory of this registration (no provider while the key pass-through is PENDING). */
export function destinationInventorySha256(o: { apiPort: number; endpoint: unknown; unixSockets: readonly string[] }): string {
  const inventory = { contractVersion: 'RevalDestinationInventoryV1', apiListener: `127.0.0.1:${o.apiPort}`, database: o.endpoint,
    ownerUnixSockets: [...o.unixSockets].sort(), dns: 'NONE', provider: 'NONE_KEY_PENDING' };
  return createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
}
/** Network-capable registered components without platform enforcement on this platform: O, C, I and the browser. */
export const UNENFORCED_COMPONENTS = Object.freeze(['OWNER_CLI', 'CONTROLLER', 'INSTRUMENT', 'BROWSER']);

/** The exact PLATFORM_PROOF for the current S (pure; validated). */
export function composePlatformProof(o: { registrationId: string; buildManifestSha256: string; serverBootId: string; enforced: boolean;
  inventorySha256: string; intervalStart: string; intervalEnd: string }): PlatformProof {
  const base = { environmentId: o.registrationId, buildManifestSha256: o.buildManifestSha256, serverBootId: o.serverBootId,
    policyEvidenceRef: o.enforced ? SERVER_POLICY_REF : NO_POLICY_REF, destinationInventorySha256: o.inventorySha256,
    intervalStart: o.intervalStart, intervalEnd: o.intervalEnd, processCoverage: o.enforced ? 'COMPLETE' : 'UNKNOWN', destinationCoverage: 'UNKNOWN',
    unexpectedDestinationCount: '0', unknownDestinationCount: '0', unmeasuredProcessCount: String(UNENFORCED_COMPONENTS.length), mode: 'MEASURED' } as const;
  return decodePlatformProof({ ...base, countsAsVerifiedZero: platformVerifiedZero(base) });
}
