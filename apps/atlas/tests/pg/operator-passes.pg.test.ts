import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type { NormalizedEvent } from '../../packages/core/contracts.ts';
import type { ResolvedConnection } from '../../connectors/contracts.ts';
import { resolveConnection } from '../../packages/connections/connections.ts';
import { ingestEvent } from '../../packages/events/inbox.ts';
import { defaultDecisionConfig } from '../../packages/decisions/provider.ts';
import { DecisionGuard } from '../../packages/decisions/guard.ts';
import { runShadowPass, runWorkerPass } from '../../packages/ops/worker-pass.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, other } from '../support/graph-fixtures.ts';
import { incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';
import { calledDuring, heldShadowProvider, modelRoute } from '../support/decision-fixtures.ts';

// Review C2 on PostgreSQL 17 through the runtime role: the operator's baseline pass (`worker-once`) and shadow pass
// (`shadow-once`) are separate entry points over all the operator's clients. The baseline pass never calls the provider in
// shadow mode, and a held shadow call of one client does not hold back the CRITICAL event of another.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const db2 = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await db2.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
await pgdb.owner.query(`INSERT INTO "Client" VALUES ('demo-vardahei','demo-other','Other client (synthetic)');
  INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status")
    VALUES ('demo-vardahei','demo-other','other-atera','atera','atera-synthetic-other','fixture://no-credentials','FIXTURE');`);
const { connection: gastaHuntress } = await liveHuntressWithConfirmedAgent(db);
const otherAtera = await resolveConnection(db, actors.sync, other, 'other-atera', 'sync');
/** A synthetic Atlas-normalized Atera alert (not a vendor payload) on the other client's fixture connection. */
const criticalAlert = (c: ResolvedConnection, id: string): NormalizedEvent => ({ workspaceId: c.workspaceId, clientId: c.clientId, source: 'atera',
  connectionId: c.connectionId, resourceType: 'alert', externalEventId: id, revision: '1', externalDevice: null, occurredAt: '2026-10-07T06:40:00.000Z',
  receivedAt: new Date().toISOString(), kind: 'DISK_CAPACITY', sourceSeverity: 'CRITICAL', summary: 'Synthetic disk alert', facts: { diskPercent: 99 } });
const held = heldShadowProvider(() => modelRoute('MONITOR'));
const runtime = { config: defaultDecisionConfig, provider: held.provider, guard: new DecisionGuard(defaultDecisionConfig) };
/** Fails instead of hanging when a pass waits for the held provider call. */
async function within<T>(pass: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish while the shadow call was held`)), ms); });
  try { return await Promise.race([pass, late]); } finally { clearTimeout(timer); }
}
const observations = async (clientId: string) => (await pgdb.owner.query(`SELECT o.severity||'|'||o.priority||'|'||o.route||'|'||(SELECT count(*) FROM "DecisionRun" d
  WHERE d."workspaceId" = o."workspaceId" AND d."clientId" = o."clientId" AND d."eventId" = o."eventId" AND d.applied) AS s FROM "Observation" o WHERE o."clientId" = $1`,
  [clientId])).rows.map(r => r.s as string);

test('a held shadow call of the first client never holds back the baseline of the second; the baseline pass makes no provider call', async () => {
  assert.equal(defaultDecisionConfig.mode, 'shadow');
  await ingestEvent(db, actors.sync, gastaHuntress, incident(gastaHuntress, 'pass-low', 'LOW'));
  const baseline = runWorkerPass(db, actors.sync, runtime, 'worker-a');
  if (await Promise.race([held.started.then(() => true), baseline.then(() => false)])) {
    held.release(); await baseline;
    assert.fail('shadow mode: the baseline pass called the provider');
  }
  assert.deepEqual(await baseline, [{ clientId: 'demo-gasta', events: { PROCESSED: 1 } }, { clientId: 'demo-other', events: {} }]);
  assert.equal(held.provider.calls, 0, 'shadow mode: the baseline pass decided by rules and only created the shadow job');
  await ingestEvent(db, actors.sync, otherAtera, criticalAlert(otherAtera, 'pass-critical'));
  const shadowPass = runShadowPass(db2, actors.sync, runtime, 'shadow-a');
  try {
    await calledDuring(held.started, shadowPass); // the first client's shadow call is in flight and held
    assert.deepEqual(await within(runWorkerPass(db, actors.sync, runtime, 'worker-a'), 'the baseline pass'),
      [{ clientId: 'demo-gasta', events: {} }, { clientId: 'demo-other', events: { PROCESSED: 1 } }]);
    assert.deepEqual(await observations('demo-other'), ['CRITICAL|URGENT|HUMAN_REVIEW|1'], 'applied baseline and URGENT observation while the shadow call is still held');
    assert.equal(held.provider.calls, 1);
  } finally { held.release(); }
  assert.deepEqual(await shadowPass, [{ clientId: 'demo-gasta', shadow: { DONE: 1 } }, { clientId: 'demo-other', shadow: { DONE: 1 } }],
    'the second client job, created meanwhile, is taken by the same pass');
  assert.deepEqual(await observations('demo-gasta'), ['LOW|NORMAL|INVESTIGATE|1'], 'the model said MONITOR: the shadow run changes no observation');
});

test('outside shadow mode the shadow pass is empty and calls nothing', async () => {
  const rules = { ...runtime, config: { ...defaultDecisionConfig, mode: 'rules' as const }, provider: { ...held.provider, mode: 'rules' as const } };
  const calls = held.provider.calls;
  assert.deepEqual(await runShadowPass(db, actors.sync, rules, 'shadow-a'), []);
  assert.equal(held.provider.calls, calls);
});
