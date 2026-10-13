import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { computeDigests, PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { registerSandbox } from '../../packages/reval/register.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { fenceOf, PRICE } from './ask-remote-pg.ts';
import { ACTOR, CLIENT, WS, install, ownerTx, pidOf, provisionSandbox, q, registration } from './reval-fixture-pg.ts';
import { nonsuperDatabase } from './reval-nonsuper.ts';
import { dockerPhysical, NODE_REALPATH, privateDir, writeOwnerConfig } from './reval-test-deps.ts';

/**
 * TEST-ONLY shared setup of the segment runs (RS-D-A segments, RS-D-C integrated rehearsal): a non-superuser throwaway database with the
 * RS-B sandbox registered for C's build digest and FX07 installed (the first fixture of the grouped order), the actor's bearer, the
 * helper, the owner config writer, and short-lived owner connections — the harness owner connection is CLOSED, so DRAIN can be
 * QUIESCENT (RS-D-B: every DB backend must be S's or C's). Call `cleanup()` in `after`.
 */
export async function segmentHarness(name: string) {
  const ns = await nonsuperDatabase();
  const { db } = ns; const owner = db.owner;
  const physical = await dockerPhysical(ns.admin);
  await ns.admin.end();
  const helper = buildPeer(`${await privateDir(name)}/peer`);
  const digests = await computeDigests(PROJECT_ROOT, NODE_REALPATH, helper.sha256);
  const { admissionId } = await provisionSandbox(owner);
  const r = registration(admissionId, db.revalReaderRole, digests.buildManifestSha256);
  const pid = await pidOf(owner);
  await registerSandbox(q(owner), r, [pid]);
  await install(owner, r, 'FX07', '0', [pid]);
  const bearer = generateToken();
  await ownerTx(owner, () => owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-seg', $2, $3)`, [WS, ACTOR, hashToken(bearer)]));
  const u = new URL(db.ownerUrl); const tcp = { host: u.hostname, port: Number(u.port || 5432) };
  const setupFence = String(await fenceOf(owner, WS));
  await owner.end();
  const roles = { reader: db.revalReaderRole, runtime: db.runtimeRole, owner: ns.ownerRole };
  async function withOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: ns.ownerUrl }); await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => undefined); }
  }
  /** The owner config of one run (LAUNCH mode: C launches the BUILT bridge S on `serverPort`). */
  const ownerConfig = (dir: string, serverPort: number) => writeOwnerConfig(dir, { contractVersion: 'RevalOwnerConfigV1', registrationId: r.registrationId,
    databaseInstanceId: r.databaseInstanceId, workspaceId: WS, clientId: CLIENT, actorId: ACTOR, admissionId, approvedPriceRevision: PRICE,
    nativePeerHelper: helper.path, nativePeerHelperSha256: helper.sha256, endpoint: { socketDir: '/docker-test-only', port: tcp.port, database: db.name }, roles, physical,
    server: { mode: 'LAUNCH', apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: serverPort } } as never,
  { reader: db.revalReaderPassword, runtime: new URL(db.runtimeUrl).password, owner: ns.ownerPassword });
  /** The fixture switch with S and C connected (D2: only the registered roles' idle sessions are admitted). */
  const switchFixture = (fixtureId: string, generation: string) => withOwner(async c => install(c, r, fixtureId, generation, [await pidOf(c)], undefined, undefined,
    { runtime: roles.runtime, reader: roles.reader }));
  return { ns, db, r, admissionId, helper, digests, bearer, tcp, setupFence, roles, withOwner, ownerConfig, switchFixture, cleanup: () => ns.cleanup(),
    ownerEntry: fileURLToPath(new URL('./reval-test-owner-entry.ts', import.meta.url)), driver: fileURLToPath(new URL('./reval-segment-entry.ts', import.meta.url)) };
}
/** The JSON object of an `OK <KIND> {…}` line. */
export const kv = (line: string) => JSON.parse(line.slice(line.indexOf('{')));
