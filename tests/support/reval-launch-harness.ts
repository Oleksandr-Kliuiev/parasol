import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeDigests, PROJECT_ROOT } from '../../packages/reval/launch.ts';
import { buildPeer } from '../../scripts/reval-server/build-peer.ts';
import { PRICE, freshProject } from './ask-remote-pg.ts';
import { registerSandbox } from './reval-pg.ts';
import type { NonsuperDb } from './reval-nonsuper.ts';
import { dockerPhysical, NODE_REALPATH, privateDir, writeOwnerConfig, writePrivate } from './reval-test-deps.ts';
import { PtySession } from './reval-pty.ts';

/**
 * TEST-ONLY launch harness on Docker PG17 (shared by the RS-A launch/deadline/control tests): one fresh project and
 * registration per session, a real 0600 owner config, the test controller's knobs in `test.json`, and O (production owner CLI
 * library via the test owner entry) under a REAL PTY. Earlier registrations are retired (owner disables its guard briefly).
 */
export interface SessionOptions { build?: string; physical?: Record<string, string>; helperSha256?: string }
export async function launchHarness(n: NonsuperDb) {
  const { db, admin } = n;
  const work = await privateDir('launch');
  const helper = buildPeer(`${work}/peer`);
  const ownerEntry = fileURLToPath(new URL('./reval-test-owner-entry.ts', import.meta.url));
  const u = new URL(db.ownerUrl); const tcp = { host: u.hostname, port: Number(u.port || 5432) };
  const physical = await dockerPhysical(admin);
  const secrets = { reader: db.revalReaderPassword, runtime: new URL(db.runtimeUrl).password, owner: n.ownerPassword };
  let port = 3600 + Math.floor(Math.random() * 300); let count = 0;
  async function retire(): Promise<void> {
    await db.owner.query(`ALTER TABLE "RevalFixtureBinding" DISABLE TRIGGER USER`); await db.owner.query(`ALTER TABLE "RevalSandboxRegistration" DISABLE TRIGGER USER`);
    try {
      for (const t of ['RevalFixtureBinding', 'RevalSandboxRegistration']) for (const r of (await admin.query(`SELECT DISTINCT "workspaceId" AS w FROM "${t}"`)).rows) {
        await db.owner.query('BEGIN'); await db.owner.query(`SELECT set_config('app.workspace_id', $1, true)`, [r.w]); await db.owner.query(`DELETE FROM "${t}"`); await db.owner.query('COMMIT');
      }
    } finally {
      await db.owner.query(`ALTER TABLE "RevalFixtureBinding" ENABLE ALWAYS TRIGGER "RevalFixtureBinding_guard", ENABLE ALWAYS TRIGGER "RevalFixtureBinding_truncate"`);
      await db.owner.query(`ALTER TABLE "RevalSandboxRegistration" ENABLE ALWAYS TRIGGER "RevalSandboxRegistration_guard", ENABLE ALWAYS TRIGGER "RevalSandboxRegistration_truncate"`);
    }
  }
  async function session(mode: 'LAUNCH' | 'NONE', lines: (p: { admissionId: string; policyVersion: string }) => string[], extra: Record<string, unknown> = {},
    over: SessionOptions = {}) {
    await retire();
    const p = await freshProject(db.owner, `ln${++count}`);
    const digests = await computeDigests(PROJECT_ROOT, NODE_REALPATH, helper.sha256);
    const reg = await registerSandbox(db.owner, p, db.revalReaderRole, { buildManifestSha256: over.build ?? digests.buildManifestSha256 });
    const dir = await privateDir(`ln${count}`);
    const serverPort = ++port;
    const { path: config } = await writeOwnerConfig(dir, { contractVersion: 'RevalOwnerConfigV1', registrationId: reg.registrationId, databaseInstanceId: reg.databaseInstanceId,
      workspaceId: p.ws, clientId: p.client, actorId: p.actor, admissionId: p.admissionId, approvedPriceRevision: PRICE, nativePeerHelper: helper.path,
      nativePeerHelperSha256: over.helperSha256 ?? helper.sha256, endpoint: { socketDir: '/docker-test-only', port: tcp.port, database: db.name },
      roles: { reader: db.revalReaderRole, runtime: db.runtimeRole, owner: n.ownerRole }, physical: { ...physical, ...over.physical },
      server: { mode, apiEntry: realpathSync(`${PROJECT_ROOT}/dist/apps/api/src/main.js`), port: serverPort } } as never, secrets);
    const probes = { controllerFdProbe: `${dir}/c.fds`, serverFdProbe: `${dir}/s.fds`, fdProbeFile: `${dir}/e.fds`, sentinelFile: `${dir}/c.sentinels`, secretLog: `${dir}/secrets.log`,
      exitCodeFile: `${dir}/c.exit`, fsSecretLog: `${dir}/fs-secrets.log` };
    await writePrivate(dir, 'test.json', JSON.stringify({ ...tcp, ...probes, ...extra }));
    const pty = new PtySession(dir, ownerEntry, ['--config', config], lines(p));
    return { p, reg, dir, config, pty, probes, digests, serverPort };
  }
  return { session, helper, tcp, physical, retire };
}
