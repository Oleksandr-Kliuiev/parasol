import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import type { GraphTransport } from '../../connectors/microsoft365/http.ts';
import { syncM365Directory } from '../../packages/m365/directory.ts';
import { createM365SignInRequest, requeueM365RootJob } from '../../packages/m365/windows.ts';
import { runM365SignInRequest } from '../../packages/m365/ingest.ts';
import { gasta, other } from '../support/graph-fixtures.ts';
import { m365Actors } from '../support/m365-fixtures.ts';
import { mockM365, page, syntheticSecrets, userRow } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { hourStart, iso, signInRoute } from '../support/m365-signin-mock.ts';
import { guid } from '../m365-sql-invariants.ts';

// Review RC2-R4 on PostgreSQL 17: permission/scope denials at the public directory and sign-in sync boundaries — before
// any claim, between pages and before publication — stop all further I/O and publication, are appended exactly once to
// the workspace security audit (requested client ID, safe code, empty metadata) and write nothing into the client.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer } = m365Actors;
const HOUR = 3_600_000; const MIN = 60_000;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
let c = 0;
const fresh = async () => { const id = `m365-den-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
const at = (t: number) => () => new Date(t);
const membership = (permissions: string[]) => pgdb.owner.query(`UPDATE "ClientMembership" SET permissions = $1 WHERE "actorId" = 'demo-m365-syncer' AND "clientId" = 'demo-gasta'`, [permissions]);
const withdraw = () => membership(['context:read']);
const restore = () => membership(['events:ingest', 'connections:manage']);
const denials = async (eventType: string) => (await pgdb.owner.query(`SELECT "workspaceId", "actorId", outcome, "requestedClientId", "reasonCode", metadata
  FROM "SecurityAuditEvent" WHERE "eventType" = $1 ORDER BY "recordedAt", id`, [eventType])).rows;
const clientRows = async (connectionId: string) => (await pgdb.owner.query(`SELECT "eventType" FROM "AuditEvent" WHERE metadata->>'connectionId' = $1 ORDER BY "recordedAt"`,
  [connectionId])).rows.map(r => r.eventType);
const denial = (actorId: string, clientId: string, code: string) => ({ workspaceId: 'demo-vardahei', actorId, outcome: 'DENIED', requestedClientId: clientId, reasonCode: code, metadata: {} });
/** Transport that withdraws the syncer's authority right after the `n`-th response of `path` arrived. */
function withdrawAfter(mock: ReturnType<typeof mockM365>, path: string, n: number): GraphTransport {
  let seen = 0;
  return async (url, init) => { const response = await mock.graph(url, init); if (new URL(url).pathname === path && ++seen === n) await withdraw(); return response; };
}

test('pre-I/O: missing permission and foreign client are refused at every public sync boundary, audited once each, no request', async () => {
  const { id, tenant } = await fresh();
  const mock = mockM365(tenant); const secrets = syntheticSecrets();
  const { admin } = m365Actors; // connections:manage only
  await assert.rejects(syncM365Directory(db, admin, gasta, id, 'm365_user', ioOf(mock, secrets)), fails('PERMISSION_DENIED'));
  await assert.rejects(syncM365Directory(db, syncer, other, id, 'm365_user', ioOf(mock, secrets)), fails('SCOPE_DENIED'));
  assert.deepEqual(await denials('m365.directory_sync_denied'), [denial('demo-admin', 'demo-gasta', 'PERMISSION_DENIED'), denial('demo-m365-syncer', 'demo-other', 'SCOPE_DENIED')]);
  const root = hourStart(3);
  await assert.rejects(createM365SignInRequest(db, admin, gasta, id, root, new Date(root.getTime() + HOUR)), fails('PERMISSION_DENIED'));
  await assert.rejects(runM365SignInRequest(db, admin, gasta, id, guid('0'), ioOf(mock, secrets)), fails('PERMISSION_DENIED'));
  await assert.rejects(requeueM365RootJob(db, syncer, other, id, guid('0'), guid('0')), fails('SCOPE_DENIED'));
  assert.deepEqual(await denials('m365.signin_sync_denied'), [denial('demo-admin', 'demo-gasta', 'PERMISSION_DENIED'), denial('demo-admin', 'demo-gasta', 'PERMISSION_DENIED')]);
  assert.deepEqual(await denials('m365.signin_requeue_denied'), [denial('demo-m365-syncer', 'demo-other', 'SCOPE_DENIED')]);
  assert.deepEqual([mock.requests, secrets.calls, await clientRows(id)], [[], [], []]);
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "AuditEvent" WHERE "clientId" = 'demo-other'`)).rows[0].n), 0, 'nothing in the foreign client');
});

for (const [label, pages, withdrawAt] of [['between pages', 2, 1], ['before publication', 1, 1]] as const) {
  test(`directory: authority withdrawn ${label} → no further I/O, no publication, one workspace denial, no client failure row`, async () => {
    const { id, tenant } = await fresh();
    const mock = mockM365(tenant, { route: (url, n) => url.pathname !== '/v1.0/users' ? undefined
      : page([userRow(guid(String(n + 1)))], n + 1 < pages ? `https://graph.microsoft.com/v1.0/users?$skiptoken=p${n + 1}` : undefined) });
    const before = (await denials('m365.directory_sync_denied')).length;
    try {
      await assert.rejects(syncM365Directory(db, syncer, gasta, id, 'm365_user', { ...ioOf(mock), graph: withdrawAfter(mock, '/v1.0/users', withdrawAt) }),
        fails('PERMISSION_DENIED'));
    } finally { await restore(); }
    assert.equal(mock.gets('/v1.0/users').length, withdrawAt, 'no request after the withdrawal');
    const state = (await pgdb.owner.query(`SELECT "activeGenerationId" AS active, "latestRecordedSeq" AS recorded, status FROM "M365ResourceState" WHERE "connectionId" = $1`, [id])).rows[0];
    assert.deepEqual(state, { active: null, recorded: 0, status: 'PENDING' }, 'neither published nor recorded by a withdrawn actor');
    assert.equal((await pgdb.owner.query(`SELECT state FROM "M365DirectoryGeneration" WHERE "connectionId" = $1`, [id])).rows[0].state, 'STAGING');
    assert.equal(Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "ExternalEntity" WHERE "connectionId" = $1`, [id])).rows[0].n), 0);
    const rows = await denials('m365.directory_sync_denied');
    assert.deepEqual(rows.slice(before), [denial('demo-m365-syncer', 'demo-gasta', 'PERMISSION_DENIED')], 'exactly one');
    assert.deepEqual(await clientRows(id), []);
  });
}

for (const [label, rows, withdrawAt] of [['between pages', 2, 1], ['before publication', 1, 1]] as const) {
  test(`sign-ins: authority withdrawn ${label} → no further I/O or root, no publication, one workspace denial, no client failure row`, async () => {
    const { id, tenant } = await fresh();
    const root = hourStart(4); const t0 = Date.now();
    const data = Array.from({ length: rows }, (_, i) => ({ id: `sig-${i}`, at: iso(root, (i + 1) * MIN) }));
    const mock = mockM365(tenant, { route: signInRoute(() => data, { pageSize: 1 }) });
    const r = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + 2 * HOUR), at(t0));
    const before = (await denials('m365.signin_sync_denied')).length;
    try {
      await assert.rejects(runM365SignInRequest(db, syncer, gasta, id, r.requestId, { ...ioOf(mock), graph: withdrawAfter(mock, '/v1.0/auditLogs/signIns', withdrawAt) }, at(t0)),
        fails('PERMISSION_DENIED'));
    } finally { await restore(); }
    assert.equal(mock.gets('/v1.0/auditLogs/signIns').length, withdrawAt, 'no request after the withdrawal');
    const attempts = (await pgdb.owner.query(`SELECT state FROM "M365WindowAttempt" WHERE "connectionId" = $1`, [id])).rows.map(a => a.state);
    assert.deepEqual(attempts, ['RUNNING'], 'the second root was never claimed; the first neither published nor recorded');
    assert.deepEqual((await pgdb.owner.query(`SELECT "publishedAttemptId" AS p FROM "M365SignInWindow" WHERE "connectionId" = $1`, [id])).rows.map(w => w.p), [null, null]);
    const audit = await denials('m365.signin_sync_denied');
    assert.deepEqual(audit.slice(before), [denial('demo-m365-syncer', 'demo-gasta', 'PERMISSION_DENIED')], 'exactly one');
    assert.deepEqual(await clientRows(id), ['m365.signin_requested'], 'nothing written into the client after the withdrawal');
  });
}
