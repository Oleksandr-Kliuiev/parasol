import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { ingestEvent } from '../../packages/events/inbox.ts';
import { processPending } from '../../packages/events/worker.ts';
import { registerExternalEntity, proposeLink, confirmLink } from '../../packages/graph/mapping.ts';
import { getClientContext } from '../../packages/graph/prisma-context.ts';
import { connectorFor, syncResource } from '../../packages/sync/snapshots.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { vendorFixture } from '../support/mock-http.ts';
import { actors, gasta, WS } from '../support/graph-fixtures.ts';
import { CountingProvider, incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';

// Task 1.6 routing on PostgreSQL 17: link conflicts and content conflicts keep CRITICAL urgent; provider failure and shadow
// follow the advisory contract; a Huntress read feeds the inbox and the worker end to end.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
await pgdb.owner.query(`INSERT INTO "Entity" VALUES ('${WS}','demo-gasta','dev-08','DEVICE'); INSERT INTO "Device" VALUES ('${WS}','demo-gasta','dev-08','GASTA-LT-08',NULL)`);
const { connection, vendor, io } = await liveHuntressWithConfirmedAgent(db);
const process = (provider: CountingProvider) => processPending(db, actors.sync, gasta, { workerId: 'worker-a', provider, retryDelayMs: () => 0 });
const join = `JOIN "RawEvent" r ON r."workspaceId" = x."workspaceId" AND r."clientId" = x."clientId" AND r.id = x."eventId"`;
const observations = async (id: string) => (await pgdb.owner.query(`SELECT x.severity||'|'||x.priority||'|'||x.route||'|'||coalesce(x."entityId",'-')||'|'||x.provider||'|'||array_to_string(x."reasonCodes", ',') AS s
  FROM "Observation" x ${join} WHERE r."externalEventId" = $1 ORDER BY x."createdAt"`, [id])).rows.map(r => r.s);
const runs = async (id: string) => (await pgdb.owner.query(`SELECT x.provider||'|'||x.mode||'|'||x.applied||'|'||x.status||'|'||coalesce(x."safeErrorCode",'-')||'|'||coalesce(x."requestedModel",'-') AS s
  FROM "DecisionRun" x ${join} WHERE r."externalEventId" = $1 ORDER BY x.applied, x.provider`, [id])).rows.map(r => r.s);

test('an agent with a quarantined conflicting link is ambiguous: the CRITICAL event is kept URGENT for human review, no entity guessed', async () => {
  const agent = await registerExternalEntity(db, actors.sync, connection, { resourceType: 'agent', externalId: '207009', attributes: {}, observedAt: new Date() });
  await confirmLink(db, actors.reviewer, gasta, (await proposeLink(db, actors.reviewer, gasta, { externalEntityId: agent.id, entityId: 'demo-device-07' })).linkId);
  const rival = await confirmLink(db, actors.reviewer, gasta, (await proposeLink(db, actors.reviewer, gasta, { externalEntityId: agent.id, entityId: 'dev-08' })).linkId);
  assert.equal(rival.status, 'QUARANTINED');
  await ingestEvent(db, actors.sync, connection, incident(connection, 'amb-1', 'CRITICAL', { agent: '207009' }));
  assert.deepEqual((await process(new CountingProvider())).map(o => o.status), ['PROCESSED']);
  assert.deepEqual(await observations('amb-1'), ['CRITICAL|URGENT|HUMAN_REVIEW|-|rules|AMBIGUOUS_DEVICE_LINK,RULES_BASELINE,SOURCE_URGENCY_FLOOR']);
});

test('a CRITICAL redelivery with different content of a processed LOW event is its own urgent review; the first observation stays', async () => {
  const provider = new CountingProvider();
  await ingestEvent(db, actors.sync, connection, incident(connection, 'rd-1', 'LOW', { summary: 'Synthetic: low' }));
  await process(provider);
  await ingestEvent(db, actors.sync, connection, incident(connection, 'rd-1', 'CRITICAL', { summary: 'Synthetic: critical variant' }));
  await process(provider);
  assert.deepEqual(await observations('rd-1'), ['LOW|NORMAL|INVESTIGATE|demo-device-07|rules|RULES_BASELINE',
    'CRITICAL|URGENT|HUMAN_REVIEW|demo-device-07|rules|REVISION_PAYLOAD_CONFLICT,RULES_BASELINE,SOURCE_URGENCY_FLOOR']);
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "eventType" = 'event.revision_conflict'`)).rows[0].n), 1);
});

test('advisory: a provider failure is a FAILED run with its model plus an applied rules run routing to HUMAN_REVIEW; the event is never dropped', async () => {
  const provider = new CountingProvider('advisory', 'openai', () => { throw new AtlasError('PROVIDER_TIMEOUT', 'TRANSIENT', { requestedModel: 'gpt-6-luna' }); });
  await ingestEvent(db, actors.sync, connection, incident(connection, 'adv-1', 'LOW'));
  assert.deepEqual((await process(provider)).map(o => o.status), ['PROCESSED']);
  assert.deepEqual(await runs('adv-1'), ['openai|advisory|false|FAILED|PROVIDER_TIMEOUT|gpt-6-luna', 'rules|advisory|true|OK|-|-']);
  assert.deepEqual(await observations('adv-1'), ['LOW|NORMAL|HUMAN_REVIEW|demo-device-07|rules|PROVIDER_UNAVAILABLE_OR_INVALID,PROVIDER_TIMEOUT']);
});

test('shadow: the rules baseline is applied at once; the AI run is stored and never applied, and does not change the observation', async () => {
  const provider = new CountingProvider('shadow', 'openai', () => ({ route: 'MONITOR', confidence: 0.99, provider: 'openai', promptVersion: 'event-route-v1',
    reasonCodes: ['MODEL_ROUTE'], requestedModel: 'gpt-6-luna', responseModel: 'gpt-6-luna' }));
  await ingestEvent(db, actors.sync, connection, incident(connection, 'sh-1', 'LOW'));
  await process(provider);
  assert.deepEqual(await observations('sh-1'), ['LOW|NORMAL|INVESTIGATE|demo-device-07|rules|RULES_BASELINE']);
  assert.deepEqual(await runs('sh-1'), ['openai|shadow|false|OK|-|gpt-6-luna', 'rules|shadow|true|OK|-|-']);
  assert.equal(provider.calls, 1);
});

test('end to end: a Huntress read feeds the inbox atomically, the worker makes the observations, a re-read adds nothing, a failed read stores nothing', async () => {
  const connector = connectorFor(db, actors.sync, connection, io);
  const first = await syncResource(db, actors.sync, connection, connector, 'incident');
  assert.deepEqual([first.status, first.eventsStored, first.eventsDuplicate], ['OK', 2, 0]);
  assert.deepEqual((await process(new CountingProvider())).map(o => o.status), ['PROCESSED', 'PROCESSED']);
  const ctx = await getClientContext(db, actors.reader, gasta);
  const fromHuntress = ctx.observations.items.filter(o => o.externalEventId === '9001' || o.externalEventId === '9002');
  assert.deepEqual(fromHuntress.map(o => `${o.externalEventId}:${o.severity}:${o.priority}:${o.entityId ?? '-'}`), ['9001:CRITICAL:URGENT:demo-device-07', '9002:LOW:NORMAL:-']);
  const again = await syncResource(db, actors.sync, connection, connector, 'incident');
  assert.deepEqual([again.eventsStored, again.eventsDuplicate], [0, 2]);
  assert.deepEqual(await process(new CountingProvider()), []);
  const before = Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "RawEvent"`)).rows[0].n);
  vendor.overrides.huntressIncidents = { status: 500 };
  assert.equal((await syncResource(db, actors.sync, connection, connector, 'incident')).status, 'ERROR');
  delete vendor.overrides.huntressIncidents;
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "RawEvent"`)).rows[0].n), before);
});

test('partial page failure: a Huntress incident read failing on page 2 stores no event of page 1 and keeps the last snapshot', async () => {
  const connector = connectorFor(db, actors.sync, connection, io);
  const page1 = vendorFixture('huntress/incident-reports-sent.json') as { incident_reports: Record<string, unknown>[] };
  const fresh = page1.incident_reports.map((r, i) => ({ ...r, id: 9100 + i, updated_at: '2026-10-07T08:00:00Z' }));
  const counts = async () => (await pgdb.owner.query(`SELECT (SELECT count(*)::int FROM "RawEvent") AS e, (SELECT jsonb_array_length(items)
    FROM "ResourceSnapshot" WHERE "connectionId" = $1 AND "resourceType" = 'incident') AS s`, [connection.connectionId])).rows[0];
  const before = await counts();
  vendor.overrides.huntressIncidents = { status: 200, body: { incident_reports: fresh, pagination: { next_page_token: 'p2' } } };
  vendor.overrides.huntressIncidentsPage2 = { status: 503 };
  const failed = await syncResource(db, actors.sync, connection, connector, 'incident');
  delete vendor.overrides.huntressIncidents; delete vendor.overrides.huntressIncidentsPage2;
  assert.deepEqual([failed.status, failed.eventsStored], ['ERROR', 0]);
  assert.ok(vendor.requests.some(r => r.url.searchParams.get('page_token') === 'p2'), 'page 2 was requested');
  assert.deepEqual(await counts(), before);
  assert.deepEqual(await process(new CountingProvider()), []);
});
