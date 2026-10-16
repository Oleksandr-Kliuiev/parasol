import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type { Actor, Severity } from '../../packages/core/contracts.ts';
import { ingestEvent } from '../../packages/events/inbox.ts';
import { processPending } from '../../packages/events/worker.ts';
import type { WorkerOptions } from '../../packages/events/worker.ts';
import { triageObservation } from '../../packages/observations/lifecycle.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta, WS } from '../support/graph-fixtures.ts';
import { CountingProvider, incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';

// Review C1 on PostgreSQL 17 through the runtime role, two pools: a person's triage of an older observation and the commit
// of a newer revision of the same incident, in both orders. Triage does not take the source-object lock, so the revision
// lifecycle must re-check the row it supersedes: the new CRITICAL revision commits normally (one applied run, an URGENT
// observation), an observation the person closed stays closed, and the audit records only transitions that happened.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const db2 = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await db2.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const { connection } = await liveHuntressWithConfirmedAgent(db);
const triager: Actor = { id: 'demo-triager', workspaceId: WS, memberships: [{ clientId: 'demo-gasta', permissions: ['context:read', 'observations:triage'] }], workspacePermissions: [] };
// Test-only gate in this throwaway database: a closing triage audit row waits until the test releases advisory lock GATE,
// so the triage transaction holds its row lock (after its UPDATE, before its commit) for as long as the test needs.
const GATE = 8124001;
await pgdb.owner.query(`
  CREATE FUNCTION test_gate_closing_triage() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW."eventType" IN ('observation.resolved', 'observation.suppressed') THEN PERFORM pg_advisory_xact_lock(${GATE}); END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER test_gate_closing_triage BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION test_gate_closing_triage();`);

const at = (hour: number) => `2026-10-07T${String(hour).padStart(2, '0')}:00:00.000Z`;
const ingest = (id: string, severity: Severity, revision: string) => ingestEvent(db, actors.sync, connection, incident(connection, id, severity, { revision }));
const worker = (extra: Partial<WorkerOptions> = {}) =>
  processPending(db, actors.sync, gasta, { workerId: 'worker-a', provider: new CountingProvider(), retryDelayMs: () => 0, ...extra });
const one = async (sql: string, params: unknown[]) => (await pgdb.owner.query<{ s: string }>(sql, params)).rows.map(r => r.s);
const observationOf = async (id: string, revision: string) => (await one(`SELECT o.id AS s FROM "Observation" o
  JOIN "RawEvent" r ON r."workspaceId" = o."workspaceId" AND r."clientId" = o."clientId" AND r.id = o."eventId" WHERE r."externalEventId" = $1 AND r.revision = $2`, [id, revision]))[0]!;
const state = async (id: string) => (await one(`SELECT status||'|'||coalesce("resolvedBy",'-')||'|'||coalesce("supersededById",'-') AS s FROM "Observation" WHERE id = $1`, [id]))[0];
const evidence = async (id: string) => (await one(`SELECT o.severity||'|'||o.priority||'|'||o.route||'|'||(SELECT count(*) FROM "DecisionRun" d
  WHERE d."workspaceId" = o."workspaceId" AND d."clientId" = o."clientId" AND d."eventId" = o."eventId" AND d.applied) AS s FROM "Observation" o WHERE o.id = $1`, [id]))[0];
const audits = async (id: string) => one(`SELECT "actorId"||'|'||"eventType"||'|'||coalesce(metadata->>'observationStatus','-')||'|'||coalesce(metadata->>'supersededById','-') AS s
  FROM "AuditEvent" WHERE metadata->>'observationId' = $1 ORDER BY "recordedAt", "eventType"`, [id]);
/** Waits until another backend of this database waits for a lock while running `statement`; fails instead of hanging. */
async function blockedOn(statement: RegExp, who: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const waiting = await one(`SELECT query AS s FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`, []);
    if (waiting.some(q => statement.test(q))) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${who} never waited for the lock`);
}
/** An OPEN LOW observation of revision 06:00, processed, and a stored CRITICAL revision 07:00 of the same incident. */
async function olderObservationAndNewerRevision(id: string): Promise<string> {
  await ingest(id, 'LOW', at(6));
  assert.equal((await worker())[0]?.status, 'PROCESSED');
  await ingest(id, 'CRITICAL', at(7));
  return observationOf(id, at(6));
}
const closing = { resolve: 'RESOLVED', suppress: 'SUPPRESSED' } as const;

for (const action of ['resolve', 'suppress'] as const) {
  test(`triage first (${action}): the newer CRITICAL revision commits normally and the observation the person closed stays closed`, async () => {
    const older = await olderObservationAndNewerRevision(`race-triage-first-${action}`);
    await pgdb.owner.query('SELECT pg_advisory_lock($1)', [GATE]);
    let released = false;
    const release = async () => { if (!released) { released = true; await pgdb.owner.query('SELECT pg_advisory_unlock($1)', [GATE]); } };
    try {
      const triage = triageObservation(db2, triager, gasta, older, action, { expectedStatus: 'OPEN' });
      await blockedOn(/advisory_xact_lock|INSERT INTO "public"\."AuditEvent"/, 'triage'); // updated, holding the row, before commit
      const pass = worker();
      await blockedOn(/UPDATE "public"\."Observation"/, 'the worker'); // its supersede waits for the triage transaction
      await release();
      assert.deepEqual(await triage.then(r => [r.previousStatus, r.status]), ['OPEN', closing[action]]);
      const [outcome] = await pass;
      assert.deepEqual([outcome?.status, outcome?.safeErrorCode], ['PROCESSED', null], 'no dead letter from the race');
      const newer = await observationOf(`race-triage-first-${action}`, at(7));
      assert.deepEqual([await state(older), await state(newer), await evidence(newer)], [`${closing[action]}|demo-triager|-`, 'OPEN|-|-', 'CRITICAL|URGENT|HUMAN_REVIEW|1']);
      assert.deepEqual(await audits(older), ['demo-sync|observation.created|-|-', `demo-triager|observation.${action === 'resolve' ? 'resolved' : 'suppressed'}|${closing[action]}|-`],
        'no superseded audit for a transition that did not happen');
    } finally { await release(); }
  });

  test(`revision first (${action}): the person's triage waits, then sees the superseded observation and is refused as changed`, async () => {
    const older = await olderObservationAndNewerRevision(`race-revision-first-${action}`);
    let entered!: () => void; let release!: () => void;
    const inFinalTransaction = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pass = worker({ beforeFinalCommit: async () => { entered(); await gate; } });
    try {
      await Promise.race([inFinalTransaction, pass.then(() => { throw new Error('the pass ended before its final commit'); })]);
      const triage = triageObservation(db2, triager, gasta, older, action, { expectedStatus: 'OPEN' });
      await blockedOn(/FOR UPDATE/, 'triage'); // the worker superseded the row and holds it until commit
      release();
      const [outcome] = await pass;
      assert.deepEqual([outcome?.status, outcome?.safeErrorCode], ['PROCESSED', null]);
      await assert.rejects(triage, /OBSERVATION_STATUS_CHANGED/);
      const newer = await observationOf(`race-revision-first-${action}`, at(7));
      assert.deepEqual([await state(older), await state(newer), await evidence(newer)], [`SUPPRESSED|demo-sync|${newer}`, 'OPEN|-|-', 'CRITICAL|URGENT|HUMAN_REVIEW|1']);
      assert.deepEqual(await audits(older), ['demo-sync|observation.created|-|-', `demo-sync|observation.superseded|SUPPRESSED|${newer}`]);
    } finally { release(); }
  });
}
