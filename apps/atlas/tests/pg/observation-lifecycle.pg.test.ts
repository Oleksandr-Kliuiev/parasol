import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type { Actor, ObservationStatus, Severity } from '../../packages/core/contracts.ts';
import { activeObservationStatuses, observationStatuses, severities } from '../../packages/core/contracts.ts';
import { ingestEvent } from '../../packages/events/inbox.ts';
import { processPending } from '../../packages/events/worker.ts';
import type { WorkerOptions } from '../../packages/events/worker.ts';
import { triageObservation } from '../../packages/observations/lifecycle.ts';
import { getClientContext, getObservationPage } from '../../packages/graph/prisma-context.ts';
import { withScope } from '../../packages/graph/scoped-db.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta, WS } from '../support/graph-fixtures.ts';
import { CountingProvider, incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';
import { calledDuring } from '../support/decision-fixtures.ts';

// Task 1.8 on PostgreSQL 17 through the runtime role: a person's lifecycle changes with author, time and audit; the context
// lists the active observations; revisions of one incident supersede older ones (never closing urgent evidence for a
// non-urgent revision, never touching content conflicts), also when two revisions commit at the same time; pages with
// filters and a keyset cursor.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const db2 = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await db2.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const { connection } = await liveHuntressWithConfirmedAgent(db);
const triager: Actor = { id: 'demo-triager', workspaceId: WS, memberships: [{ clientId: 'demo-gasta', permissions: ['context:read', 'observations:triage'] }], workspacePermissions: [] };
const worker = (database = db, extra: Partial<WorkerOptions> = {}) =>
  processPending(database, actors.sync, gasta, { workerId: 'worker-a', provider: new CountingProvider(), retryDelayMs: () => 0, ...extra });
const ingest = (id: string, severity: Severity, revision?: string, summary?: string) =>
  ingestEvent(db, actors.sync, connection, incident(connection, id, severity, { revision, summary }));
const at = (hour: number, minute = 0) => `2026-10-07T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
const observationOf = async (externalId: string, revision = at(6, 45), conflict = false): Promise<string> =>
  (await pgdb.owner.query(`SELECT o.id FROM "Observation" o JOIN "RawEvent" r ON r."workspaceId" = o."workspaceId" AND r."clientId" = o."clientId" AND r.id = o."eventId"
    WHERE r."externalEventId" = $1 AND r.revision = $2 AND (r."conflictOfEventKey" IS NOT NULL) = $3`, [externalId, revision, conflict])).rows[0].id;
const state = async (id: string) => (await pgdb.owner.query(`SELECT status||'|'||coalesce("acknowledgedBy",'-')||'|'||coalesce("resolvedBy",'-')||'|'||coalesce("supersededById",'-') AS s
  FROM "Observation" WHERE id = $1`, [id])).rows[0].s as string;
const audits = async (id: string) => (await pgdb.owner.query(`SELECT "eventType"||'|'||coalesce(metadata->>'previousStatus','-')||'|'||coalesce(metadata->>'observationStatus','-')||'|'||
  coalesce(metadata->>'supersededById','-') AS s FROM "AuditEvent" WHERE metadata->>'observationId' = $1 ORDER BY "recordedAt", "eventType"`, [id])).rows.map(r => r.s as string);
const page = (statuses: readonly ObservationStatus[], selected: readonly Severity[], limit: number, cursor: string | null = null) =>
  getObservationPage(db, actors.reader, gasta, { statuses: [...statuses], severities: [...selected], limit, cursor });

test('a person acknowledges, resolves, reopens and suppresses; each change records author and time with its audit row; nothing else is allowed', async () => {
  await ingest('lc-1', 'LOW'); await worker();
  const id = await observationOf('lc-1');
  assert.deepEqual(await triageObservation(db, triager, gasta, id, 'acknowledge').then(r => [r.previousStatus, r.status]), ['OPEN', 'ACKNOWLEDGED']);
  assert.equal(await state(id), 'ACKNOWLEDGED|demo-triager|-|-');
  await assert.rejects(triageObservation(db, triager, gasta, id, 'acknowledge'), /TRANSITION_NOT_ALLOWED/);
  await assert.rejects(triageObservation(db, triager, gasta, id, 'resolve', { expectedStatus: 'OPEN' }), /OBSERVATION_STATUS_CHANGED/, 'a change made meanwhile is not overwritten');
  await triageObservation(db, triager, gasta, id, 'resolve', { expectedStatus: 'ACKNOWLEDGED' });
  assert.equal(await state(id), 'RESOLVED|demo-triager|demo-triager|-', 'the acknowledgement stays as history');
  await triageObservation(db, triager, gasta, id, 'reopen');
  assert.equal(await state(id), 'OPEN|-|-|-');
  await triageObservation(db, triager, gasta, id, 'suppress');
  assert.equal(await state(id), 'SUPPRESSED|-|demo-triager|-');
  assert.deepEqual(await audits(id), ['observation.created|-|-|-', 'observation.acknowledged|OPEN|ACKNOWLEDGED|-', 'observation.resolved|ACKNOWLEDGED|RESOLVED|-',
    'observation.reopened|RESOLVED|OPEN|-', 'observation.suppressed|OPEN|SUPPRESSED|-']);
  await assert.rejects(triageObservation(db, actors.reader, gasta, id, 'reopen'), /PERMISSION_DENIED/);
  await assert.rejects(triageObservation(db, triager, gasta, 'no-such-observation', 'reopen'), /OBSERVATION_NOT_FOUND/);
  await assert.rejects(triageObservation(db, triager, gasta, "bad'id", 'reopen'), /INVALID_OBSERVATION_ID/);
  await assert.rejects(withScope(db, triager, ['demo-gasta'], tx => tx.observation.update({ where: { workspaceId_clientId_id: { ...gasta, id } },
    data: { severity: 'CRITICAL', severityRank: 4, priority: 'URGENT' }, select: { id: true } })), /evidence is immutable/, 'not even the runtime role in its own scope');
});

test('the context lists OPEN and ACKNOWLEDGED observations in priority order and counts only them; closed ones keep their source link', async () => {
  for (const [id, severity] of [['ctx-crit', 'CRITICAL'], ['ctx-med-1', 'MEDIUM'], ['ctx-med-2', 'MEDIUM'], ['ctx-med-3', 'MEDIUM']] as const) await ingest(id, severity);
  await worker();
  await triageObservation(db, triager, gasta, await observationOf('ctx-crit'), 'acknowledge');
  await triageObservation(db, triager, gasta, await observationOf('ctx-med-1'), 'resolve');
  await triageObservation(db, triager, gasta, await observationOf('ctx-med-2'), 'suppress');
  const ctx = await getClientContext(db, actors.reader, gasta);
  assert.deepEqual(ctx.observations.items.filter(o => o.externalEventId.startsWith('ctx-')).map(o => `${o.externalEventId}:${o.status}`),
    ['ctx-crit:ACKNOWLEDGED', 'ctx-med-3:OPEN'], 'an acknowledged CRITICAL is still first; closed ones are not listed');
  const counted = (await pgdb.owner.query(`SELECT severity, count(*)::int AS n FROM "Observation" WHERE "clientId" = 'demo-gasta' AND status IN ('OPEN','ACKNOWLEDGED') GROUP BY severity`)).rows;
  assert.deepEqual(Object.entries(ctx.observations.counts).filter(([, n]) => n > 0).sort(), counted.map(r => [r.severity, r.n]).sort());
  const resolved = (await page(['RESOLVED'], severities, 10)).items.find(o => o.externalEventId === 'ctx-med-1')!;
  assert.deepEqual([resolved.status, resolved.resolvedAt !== null, resolved.source, resolved.connectionId, resolved.resourceType, resolved.revision, resolved.decisionRunId !== null],
    ['RESOLVED', true, 'huntress', connection.connectionId, 'incident', at(6, 45), true]);
});

test('revisions: the newer supersedes the older, a late one is superseded at once; urgent evidence is never closed for a non-urgent revision; conflicts stay', async () => {
  await ingest('rev-1', 'LOW', at(6)); await worker();
  await ingest('rev-1', 'LOW', at(7)); await worker();
  const [o6, o7] = [await observationOf('rev-1', at(6)), await observationOf('rev-1', at(7))];
  assert.deepEqual([await state(o6), await state(o7)], [`SUPPRESSED|-|demo-sync|${o7}`, 'OPEN|-|-|-']);
  assert.ok((await audits(o6)).includes(`observation.superseded|-|SUPPRESSED|${o7}`));
  await ingest('rev-1', 'LOW', at(6, 30)); await worker();
  assert.equal(await state(await observationOf('rev-1', at(6, 30))), `SUPPRESSED|-|demo-sync|${o7}`, 'a late revision never becomes the current one');
  await ingest('urg-1', 'CRITICAL', at(6)); await worker(); await ingest('urg-1', 'LOW', at(7)); await worker();
  assert.deepEqual([await state(await observationOf('urg-1', at(6))), await state(await observationOf('urg-1', at(7)))], ['OPEN|-|-|-', 'OPEN|-|-|-'],
    'the CRITICAL stays for a person to close');
  await ingest('urg-2', 'LOW', at(7)); await worker(); await ingest('urg-2', 'CRITICAL', at(6)); await worker();
  assert.deepEqual([await state(await observationOf('urg-2', at(6))), await state(await observationOf('urg-2', at(7)))], ['OPEN|-|-|-', 'OPEN|-|-|-'], 'a late CRITICAL too');
  await ingest('esc-1', 'LOW', at(6)); await worker(); await ingest('esc-1', 'CRITICAL', at(7)); await worker();
  const [e6, e7] = [await observationOf('esc-1', at(6)), await observationOf('esc-1', at(7))];
  assert.deepEqual([await state(e6), await state(e7)], [`SUPPRESSED|-|demo-sync|${e7}`, 'OPEN|-|-|-'], 'an escalation supersedes');
  await ingest('cf-1', 'LOW', at(6), 'Synthetic: A'); await worker(); await ingest('cf-1', 'LOW', at(6), 'Synthetic: B'); await worker(); // not urgent: only its conflict status protects it
  await ingest('cf-1', 'LOW', at(7), 'Synthetic: A'); await worker();
  const [c6, conflict, c7] = [await observationOf('cf-1', at(6)), await observationOf('cf-1', at(6), true), await observationOf('cf-1', at(7))];
  assert.deepEqual([await state(c6), await state(conflict), await state(c7)], [`SUPPRESSED|-|demo-sync|${c7}`, 'OPEN|-|-|-', 'OPEN|-|-|-'],
    'the content conflict stays in review');
});

test('two revisions committed at the same time: the source-object lock orders them and the older one ends superseded', async () => {
  await ingest('race-1', 'LOW', at(7));
  await new Promise(resolve => setTimeout(resolve, 20)); // the newer revision is claimed first
  await ingest('race-1', 'LOW', at(6));
  let release!: () => void; let paused!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const atCommit = new Promise<void>(resolve => { paused = resolve; });
  const newer = worker(db, { workerId: 'worker-a', batchSize: 1, beforeFinalCommit: async () => { paused(); await gate; } });
  await calledDuring(atCommit, newer);
  let olderDone = false;
  const older = worker(db2, { workerId: 'worker-b', batchSize: 1 }).then(outcomes => { olderDone = true; return outcomes; });
  const waiting = async () => Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n) > 0;
  for (let i = 0; i < 200 && !olderDone && !(await waiting()); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(olderDone, false, 'the older revision waits for the newer one to commit');
  release();
  assert.deepEqual([(await newer).map(o => o.status), (await older).map(o => o.status)], [['PROCESSED'], ['PROCESSED']]);
  const [o6, o7] = [await observationOf('race-1', at(6)), await observationOf('race-1', at(7))];
  assert.deepEqual([await state(o6), await state(o7)], [`SUPPRESSED|-|demo-sync|${o7}`, 'OPEN|-|-|-']);
});

test('pages: status and severity filters, keyset cursor in priority order, counts over the selection; a cursor is bound to its filters', async () => {
  const seen: string[] = []; let cursor: string | null = null; let pages = 0;
  do {
    const current = await page(observationStatuses, severities, 3, cursor);
    seen.push(...current.items.map(o => o.id)); cursor = current.nextCursor; pages++;
    assert.equal(current.truncated, cursor !== null);
  } while (cursor);
  const expected = (await pgdb.owner.query(`SELECT id FROM "Observation" WHERE "clientId" = 'demo-gasta' ORDER BY "severityRank" DESC, "createdAt" DESC, id`)).rows.map(r => r.id);
  assert.deepEqual([seen, pages > 3], [expected, true], 'every observation exactly once, in priority order');
  const critical = await page(activeObservationStatuses, ['CRITICAL'], 100);
  assert.ok(critical.items.length > 0 && critical.items.every(o => o.severity === 'CRITICAL' && activeObservationStatuses.includes(o.status)));
  assert.deepEqual([critical.total, critical.counts.CRITICAL, critical.counts.LOW], [critical.items.length, critical.items.length, 0], 'counts cover the selection');
  const first = await page(observationStatuses, severities, 2);
  await assert.rejects(page(['OPEN'], severities, 2, first.nextCursor), /INVALID_CURSOR/, 'a cursor is bound to the filters it was issued for');
  for (const forged of ['not-a-cursor', Buffer.from('{"r":9,"t":"x","i":"y","f":"z"}').toString('base64url')]) {
    await assert.rejects(page(observationStatuses, severities, 2, forged), /INVALID_CURSOR/);
  }
  await assert.rejects(page([], severities, 2), /INVALID_OBSERVATION_QUERY/);
  await assert.rejects(page(['OPEN', 'OPEN'], severities, 2), /INVALID_OBSERVATION_QUERY/);
});
