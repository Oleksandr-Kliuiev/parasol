import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { productionDeps } from '../../packages/reval/deps.ts';
import type { ControllerDeps } from '../../packages/reval/deps.ts';
import type { OwnerConfig } from '../../packages/reval/config.ts';
import { pauseExport, reapExecutor } from '../../packages/reval/pause.ts';
import type { PauseContext } from '../../packages/reval/pause.ts';
import { readSnapshotWrapper } from '../../packages/reval/snapshot-reader.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { PRICE, freshProject, ownerScoped } from './ask-remote-pg.ts';
import { registerSandbox } from './reval-pg.ts';
import type { NonsuperDb } from './reval-nonsuper.ts';
import type { TestTcp } from './reval-test-deps.ts';
import { dockerPhysical, privateDir, writeOwnerConfig, writePrivate } from './reval-test-deps.ts';

/**
 * TEST-ONLY PAUSE_EXPORT harness on Docker PG17 (shared by the RS-A closure/control tests): the REAL executor child E
 * (test entry = production library + TCP seam + test hooks), the REAL Darwin peer proof of E, the controller's pauseExport
 * orchestration with ITS byte-capped reread, and the dedicated NOSUPERUSER NOBYPASSRLS table owner as the owner credential.
 * One registration per reader OID: setup() retires the previous one (test-only, the owner disables its guard briefly).
 */
export interface SetupOptions {
  readonly hooks?: TestTcp['hooks'];
  /** Extra test.json knobs (e.g. execDatabase: E connects to another physical database). */
  readonly test?: Partial<TestTcp>;
  readonly config?: Partial<OwnerConfig>;
  /** The owner credential written to the owner secret file (default: the real owner password). */
  readonly ownerPassword?: string;
}
export async function closureHarness(n: NonsuperDb) {
  const { db, admin } = n; const owner = db.owner;
  const work = await privateDir('closure');
  const helper = buildPeer(`${work}/peer`);
  await productionDeps().warmHelper(helper.path); // as the production controller does: first exec is assessed by the OS
  const reader = new pg.Client({ connectionString: db.revalReaderUrl }); await reader.connect();
  const execEntry = fileURLToPath(new URL('./reval-test-exec-entry.ts', import.meta.url));
  const u = new URL(db.ownerUrl);
  const tcp: TestTcp = { host: u.hostname, port: Number(u.port || 5432) };
  const physical = await dockerPhysical(admin);
  let seq = 0;
  async function retire(): Promise<void> {
    await owner.query(`ALTER TABLE "RevalFixtureBinding" DISABLE TRIGGER USER`); await owner.query(`ALTER TABLE "RevalSandboxRegistration" DISABLE TRIGGER USER`);
    try {
      for (const t of ['RevalFixtureBinding', 'RevalSandboxRegistration']) {
        const wss = (await admin.query(`SELECT DISTINCT "workspaceId" AS w FROM "${t}"`)).rows.map(r => r.w as string);
        for (const w of wss) await ownerScoped(owner, w, () => owner.query(`DELETE FROM "${t}"`));
      }
    } finally {
      await owner.query(`ALTER TABLE "RevalFixtureBinding" ENABLE ALWAYS TRIGGER "RevalFixtureBinding_guard", ENABLE ALWAYS TRIGGER "RevalFixtureBinding_truncate"`);
      await owner.query(`ALTER TABLE "RevalSandboxRegistration" ENABLE ALWAYS TRIGGER "RevalSandboxRegistration_guard", ENABLE ALWAYS TRIGGER "RevalSandboxRegistration_truncate"`);
    }
  }
  async function setup(label: string, o: SetupOptions = {}) {
    await retire();
    const p = await freshProject(owner, `${label}${++seq}`);
    const reg = await registerSandbox(owner, p, db.revalReaderRole);
    const dir = await privateDir(label);
    const captureFile = `${dir}/capture.log`;
    const testJson = await writePrivate(dir, 'test.json', JSON.stringify({ ...tcp, ...o.test, hooks: o.hooks ?? {}, captureFile }));
    const { config } = await writeOwnerConfig(dir, { contractVersion: 'RevalOwnerConfigV1', registrationId: reg.registrationId, databaseInstanceId: reg.databaseInstanceId,
      workspaceId: p.ws, clientId: p.client, actorId: p.actor, admissionId: p.admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path,
      nativePeerHelperSha256: helper.sha256, endpoint: { socketDir: '/docker-test-only', port: tcp.port, database: db.name },
      roles: { reader: db.revalReaderRole, runtime: db.runtimeRole, owner: n.ownerRole }, physical, server: { mode: 'NONE', apiEntry: '/docker-test-only/main.js', port: 3999 },
      ...o.config } as never, { reader: 'unusedReaderPassword0', runtime: 'unusedRuntimePassword0', owner: o.ownerPassword ?? n.ownerPassword });
    const deps: ControllerDeps = { ...productionDeps(), spawnExecutor: () => spawn(process.execPath, [execEntry, testJson], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: {} }) };
    let beforeReread: (() => Promise<unknown>) | null = null;
    const ctx: PauseContext = { deps, config: { ...config, ...o.config } as OwnerConfig, latched: false, spawns: 0, lastChild: null, requestSent: false,
      reread: async deadline => { if (beforeReread) await beforeReread(); return readSnapshotWrapper(reader as never, deadline, () => performance.now()); } };
    const policy = async () => ownerScoped(owner, p.ws, async () => (await owner.query(`SELECT to_jsonb(p) AS j FROM "RemoteAskPolicy" p`)).rows[0].j as Record<string, unknown>);
    const fence = async () => ownerScoped(owner, p.ws, async () => String((await owner.query(`SELECT version FROM "ActionAuthorityFence"`)).rows[0].version));
    const captured = async () => (await readFile(captureFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { sql: string; rows: unknown[] });
    const pause = async (expected: string, floors = ['0', '0']) => {
      const t0 = performance.now();
      const d = await pauseExport(ctx, { admissionId: p.admissionId, expectedPolicyVersion: expected, policyFloor: floors[0]!, fenceFloor: floors[1]! }, t0);
      const elapsed = performance.now() - t0; const reaped = await reapExecutor(ctx.lastChild);
      return { d, elapsed, reaped };
    };
    return { p, reg, ctx, dir, policy, fence, captured, pause, setReread: (fn: () => Promise<unknown>) => { beforeReread = fn; } };
  }
  return { setup, reader, tcp, physical, helper, retire, close: () => reader.end().catch(() => undefined) };
}
export type Setup = Awaited<ReturnType<Awaited<ReturnType<typeof closureHarness>>['setup']>>;
