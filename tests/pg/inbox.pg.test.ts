import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ingestEvent } from '../../packages/events/inbox.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors } from '../support/graph-fixtures.ts';
import { incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';

// Task 1.6 durable inbox on PostgreSQL 17 through the runtime role: stored once, new revisions are new evidence, a content
// conflict is its own row next to the untouched canonical one, and only the issued connection's events are accepted.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const db2 = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await db2.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const { connection } = await liveHuntressWithConfirmedAgent(db);
const rows = async (externalEventId: string) => (await pgdb.owner.query(`SELECT revision, "conflictOfEventKey" IS NOT NULL AS conflict, normalized->>'sourceSeverity' AS severity
  FROM "RawEvent" WHERE "externalEventId" = $1 ORDER BY revision, conflict`, [externalEventId])).rows.map(r => `${r.revision}:${r.conflict ? 'conflict' : 'canonical'}:${r.severity}`);
const conflictAudits = async () => Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "eventType" = 'event.revision_conflict'`)).rows[0].n);

test('stored once: a redelivery with the same content is a duplicate, also when delivered concurrently on two pools', async () => {
  const event = incident(connection, '9001', 'CRITICAL');
  assert.equal((await ingestEvent(db, actors.sync, connection, event)).outcome, 'STORED');
  assert.equal((await ingestEvent(db, actors.sync, connection, { ...event, receivedAt: new Date().toISOString() })).outcome, 'DUPLICATE', 'receivedAt is not content');
  const burst = incident(connection, '9002', 'HIGH');
  const outcomes = await Promise.all(Array.from({ length: 6 }, (_, i) => ingestEvent(i % 2 ? db2 : db, actors.sync, connection, burst)));
  assert.deepEqual(outcomes.map(o => o.outcome).sort(), ['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'STORED']);
  assert.deepEqual([await rows('9001'), await rows('9002')], [['2026-10-07T06:45:00.000Z:canonical:CRITICAL'], ['2026-10-07T06:45:00.000Z:canonical:HIGH']]);
});

test('a new revision is new evidence; the earlier revision is untouched', async () => {
  const next = incident(connection, '9001', 'HIGH', { revision: '2026-10-07T07:30:00.000Z' });
  assert.equal((await ingestEvent(db, actors.sync, connection, next)).outcome, 'STORED');
  assert.deepEqual(await rows('9001'), ['2026-10-07T06:45:00.000Z:canonical:CRITICAL', '2026-10-07T07:30:00.000Z:canonical:HIGH']);
});

test('same ID and revision with different content: a separate conflict row linked to the canonical one, audited once, canonical never overwritten', async () => {
  const canonical = await ingestEvent(db, actors.sync, connection, incident(connection, '9003', 'LOW', { summary: 'Synthetic: low' }));
  const conflict = await ingestEvent(db, actors.sync, connection, incident(connection, '9003', 'CRITICAL', { summary: 'Synthetic: critical variant' }));
  assert.deepEqual([conflict.outcome, conflict.conflictOfEventKey], ['STORED', canonical.eventKey]);
  assert.equal((await ingestEvent(db, actors.sync, connection, incident(connection, '9003', 'CRITICAL', { summary: 'Synthetic: critical variant' }))).outcome, 'DUPLICATE');
  assert.deepEqual(await rows('9003'), ['2026-10-07T06:45:00.000Z:canonical:LOW', '2026-10-07T06:45:00.000Z:conflict:CRITICAL']);
  assert.equal(await conflictAudits(), 1);
  // Two different contents for a new identity at the same time: one canonical, one conflict, one audit — nothing lost
  const both = await Promise.all([ingestEvent(db, actors.sync, connection, incident(connection, '9004', 'LOW', { summary: 'A' })),
    ingestEvent(db2, actors.sync, connection, incident(connection, '9004', 'HIGH', { summary: 'B' }))]);
  assert.deepEqual(both.map(r => r.outcome), ['STORED', 'STORED']);
  const kinds = (await pgdb.owner.query(`SELECT CASE WHEN "conflictOfEventKey" IS NULL THEN 'canonical' ELSE 'conflict' END AS k FROM "RawEvent"
    WHERE "externalEventId" = '9004' ORDER BY 1`)).rows.map(r => r.k);
  assert.deepEqual(kinds, ['canonical', 'conflict'], 'whichever content won, the other is kept as the linked conflict');
  assert.equal(await conflictAudits(), 2);
});

test('events are accepted only through the issued connection they belong to, in a valid shape, with events:ingest', async () => {
  const event = incident(connection, '9100', 'LOW');
  await assert.rejects(ingestEvent(db, actors.sync, connection, { ...event, connectionId: 'demo-huntress-connection' }), /EVENT_SCOPE_MISMATCH/);
  await assert.rejects(ingestEvent(db, actors.sync, connection, { ...event, source: 'atera' }), /EVENT_SCOPE_MISMATCH/);
  await assert.rejects(ingestEvent(db, actors.sync, connection, { ...event, clientId: 'demo-other' }), /EVENT_SCOPE_MISMATCH/);
  await assert.rejects(ingestEvent(db, actors.sync, connection, { ...event, summary: 'nul\u0000' }), /INVALID_EVENT/);
  await assert.rejects(ingestEvent(db, actors.sync, connection, { ...event, kind: 'RANSOMWARE' } as never), /INVALID_EVENT/);
  await assert.rejects(ingestEvent(db, actors.sync, { ...connection }, event), /CONNECTION_NOT_RESOLVED/);
  await assert.rejects(ingestEvent(db, actors.reviewer, connection, event), /SCOPE_DENIED|PERMISSION_DENIED/);
  assert.deepEqual(await rows('9100'), []);
});
