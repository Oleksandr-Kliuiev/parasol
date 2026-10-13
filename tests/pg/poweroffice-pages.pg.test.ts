import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { hashToken } from '../../packages/auth/token.ts';
import { generateToken } from '../../packages/auth/token.ts';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import type { SourceFaultCall } from '../../packages/poweroffice/composition.ts';
import { syncPowerOffice } from '../../packages/poweroffice/sync.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, addToken, audits, clone, codeOf, denials, observe, revokeToken, seam, sleep, untilWaiting } from '../support/poweroffice-sync.ts';
import type { SyncConnection } from '../support/poweroffice-sync.ts';

// S4-B B2/B3 on PostgreSQL 17: every page — the first included — needs a FRESH committed authorization (revocation, lost
// permission, disabled or changed binding and last-lock token expiry stop the NEXT page; the admitted read in flight is
// the only one), and only a complete, consistent, strictly valid export may contribute: any changed identity, duplicate,
// ordinal/count/size defect, malformed DTO, source failure or the 10 s per-page deadline aborts the whole pass with no
// retry, the private failure continuation closes the claim, and the previous snapshot stays published.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtime = await connect(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await prisma.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const syncer = powerOfficeCredential(tokens.syncer!);
type Page = { header: Record<string, unknown>; ordinal: number; items: Record<string, unknown>[]; hasMore: boolean } & Record<string, unknown>;

/** A connection with a prior published snapshot (to prove it survives); returns it and that first snapshot. */
async function published(id: string, items = 250): Promise<{ conn: SyncConnection; pointer: string; lastSuccessAt: string }> {
  const conn = await addSyncConnection(owner, key(id), items);
  await syncPowerOffice(prisma, seam().composition, syncer, CA, id);
  const o = await observe(runtime, conn);
  return { conn, pointer: o.state.pointer, lastSuccessAt: o.state.lastSuccessAt };
}
/** The last attempt closed FAILED with `code`, the prior snapshot still published, and its FAILED audit present. */
async function closedPreserving(prior: { conn: SyncConnection; pointer: string; lastSuccessAt: string }, code: string, label: string) {
  const o = await observe(runtime, prior.conn);
  const last = o.attempts.at(-1);
  assert.deepEqual([last.state, last.safeErrorCode], ['FAILED', code], `${label}: claim closed FAILED`);
  assert.deepEqual([o.state.pointer, o.state.lastSuccessAt, o.state.active], [prior.pointer, prior.lastSuccessAt, null], `${label}: prior snapshot preserved`);
  assert.deepEqual([o.state.lastCompletedState, o.state.lastCompletedErrorCode], ['FAILED', code]);
  assert.equal(o.snapshots.length, o.attempts.filter((a: { state: string }) => a.state === 'SUCCEEDED').length, `${label}: no snapshot for the failed pass`);
  const rows = (await audits(owner, prior.conn.connectionId)).filter(r => r.metadata.attemptId === last.id);
  assert.deepEqual(rows.map(r => [r.eventType, r.metadata.outcome, r.metadata.safeErrorCode]), [['poweroffice.sync.started', 'STARTED', undefined],
    ['poweroffice.sync.failed', 'FAILED', code]], `${label}: STARTED then FAILED audit`);
}
async function addActor(id: string, permissions: string[]): Promise<string> {
  await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName", status, "workspacePermissions") VALUES ($1, $2, 'Synthetic actor', 'ACTIVE', '{}')`, [WS, id]);
  await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1,$2,$3,$4)`, [WS, CA, id, permissions]);
  const bearer = generateToken();
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, $2, $3, $4)`, [WS, `tok-${id}`, id, hashToken(bearer)]);
  return bearer;
}

test('revocation after page 1 was admitted: that read completes, no page 2 or publication; the failure continuation closes the claim', async () => {
  const prior = await published('po-revoke');
  const bearer = await addToken(owner, WS, 'syncer');
  const s = seam(async call => { if (call.ordinal === 1) await revokeToken(owner, bearer); return call.builtIn(); });
  assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, powerOfficeCredential(bearer), CA, 'po-revoke')), 'POWEROFFICE_AUTHENTICATION_FAILED');
  assert.deepEqual(s.calls.map(c => [c.ordinal, c.outcome]), [[1, 'page']], 'the admitted page-1 read completed; nothing after it');
  await closedPreserving(prior, 'POWEROFFICE_AUTHENTICATION_FAILED', 'revoked');
});

test('a permission removed mid-pass: PERMISSION_DENIED with one workspace denial; a disabled connection or a lifecycle change stops the next page', async () => {
  const prior = await published('po-perm');
  const bearer = await addActor('syncer-perm', ['context:read', 'poweroffice:read', 'poweroffice:sync']);
  const s = seam(async call => {
    if (call.ordinal === 2) await owner.query(`UPDATE "ClientMembership" SET permissions = '{context:read,poweroffice:read}' WHERE "actorId" = 'syncer-perm'`);
    return call.builtIn();
  });
  const seen = (await denials(owner)).length;
  assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, powerOfficeCredential(bearer), CA, 'po-perm')), 'PERMISSION_DENIED');
  assert.deepEqual(s.calls.map(c => c.ordinal), [1, 2]);
  assert.deepEqual((await denials(owner)).slice(seen).map(d => [d.actorId, d.eventType, d.reasonCode]), [['syncer-perm', 'poweroffice.sync.denied', 'PERMISSION_DENIED']]);
  await closedPreserving(prior, 'PERMISSION_DENIED', 'permission');
  for (const [id, mutation, expected] of [
    ['po-off', `UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'po-off'`, 'POWEROFFICE_CONNECTION_UNAVAILABLE'],
    ['po-bump', `UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'po-bump'`, 'POWEROFFICE_BINDING_CHANGED']] as const) {
    const p = await published(id);
    const t = seam(async call => { if (call.ordinal === 1) await owner.query(mutation); return call.builtIn(); });
    assert.equal(await codeOf(syncPowerOffice(prisma, t.composition, syncer, CA, id)), expected, id);
    assert.deepEqual(t.calls.map(c => c.ordinal), [1], `${id}: no page after the binding changed`);
    await closedPreserving(p, expected, id); // the private continuation closes it despite the binding loss
  }
});

test('token expiry while a later page admission waits for the State lock: refused after the last lock; no further page', async () => {
  const prior = await published('po-page-expiry');
  const bearer = await addToken(owner, WS, 'syncer', 3000);
  const holder = await connect(pgdb.runtimeUrl);
  try {
    const s = seam(async call => {
      if (call.ordinal === 1) {
        await holder.query('BEGIN');
        await holder.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CA]);
        await holder.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'po-page-expiry' FOR UPDATE`);
      }
      return call.builtIn();
    });
    const pending = codeOf(syncPowerOffice(prisma, s.composition, powerOfficeCredential(bearer), CA, 'po-page-expiry'));
    await untilWaiting(owner, 'PowerOfficeState');
    await sleep(3200);
    await holder.query('COMMIT');
    assert.equal(await pending, 'POWEROFFICE_AUTHENTICATION_FAILED');
    assert.deepEqual(s.calls.map(c => c.ordinal), [1]);
    await closedPreserving(prior, 'POWEROFFICE_AUTHENTICATION_FAILED', 'expired at page 2');
  } finally { await holder.end(); }
});

test('whole-export rejection: every identity/ordinal/count/DTO/source defect aborts the pass at that page, no retry, prior snapshot kept', async () => {
  const prior = await published('po-reject');
  let firstId = '';
  const cases: [string, number, (p: Page) => unknown, string][] = [
    ['company key changed', 2, p => ({ ...p, header: { ...p.header, companyKey: 'synthetic-po-00000000-0000-4000-8000-000000000777' } }), 'POWEROFFICE_DTO_INVALID'],
    ['export ID changed', 2, p => ({ ...p, header: { ...p.header, exportId: '99999999-9999-4999-8999-999999999999' } }), 'POWEROFFICE_EXPORT_INCOMPLETE'],
    ['totalCount changed', 2, p => ({ ...p, header: { ...p.header, totalCount: 260 } }), 'POWEROFFICE_EXPORT_INCOMPLETE'],
    ['asOf changed', 1, p => ({ ...p, header: { ...p.header, asOf: '2020-01-01T00:00:00.000Z' } }), 'POWEROFFICE_DTO_INVALID'],
    ['not synthetic', 1, p => ({ ...p, header: { ...p.header, synthetic: false } }), 'POWEROFFICE_DTO_INVALID'],
    ['duplicate ID across pages', 2, p => { p.items[5]!.id = firstId; return p; }, 'POWEROFFICE_EXPORT_INCOMPLETE'],
    ['repeated ordinal', 2, p => ({ ...p, ordinal: 1 }), 'POWEROFFICE_EXPORT_INCOMPLETE'],
    ['non-contiguous ordinal', 2, p => ({ ...p, ordinal: 3 }), 'POWEROFFICE_EXPORT_INCOMPLETE'],
    ['empty non-final page', 2, p => ({ ...p, items: [] }), 'POWEROFFICE_EXPORT_INCOMPLETE'],
    ['short non-final page', 1, p => ({ ...p, items: p.items.slice(1) }), 'POWEROFFICE_EXPORT_INCOMPLETE'],
    ['final count short', 3, p => ({ ...p, items: p.items.slice(1) }), 'POWEROFFICE_EXPORT_INCOMPLETE'],
    ['premature final page', 2, p => ({ ...p, hasMore: false }), 'POWEROFFICE_EXPORT_INCOMPLETE'],
    ['count over the bound', 1, p => ({ ...p, header: { ...p.header, totalCount: 10_001 } }), 'POWEROFFICE_DTO_INVALID'],
    ['extra invoice field', 1, p => { (p.items[0] as Record<string, unknown>).customerName = 'x'; return p; }, 'POWEROFFICE_DTO_INVALID'],
    ['extra page field', 3, p => ({ ...p, nextLink: 'https://example.invalid/next' }), 'POWEROFFICE_DTO_INVALID'],
    ['non-canonical money', 2, p => { p.items[0]!.gross = '1.5'; return p; }, 'POWEROFFICE_DTO_INVALID'],
    ['unknown currency', 1, p => { p.items[3]!.currency = 'XXX'; return p; }, 'POWEROFFICE_DTO_INVALID'],
    ['outstanding above gross', 1, p => { p.items[0]!.gross = '1.00'; p.items[0]!.outstanding = '2.00'; return p; }, 'POWEROFFICE_DTO_INVALID'],
    ['impossible due date', 3, p => { p.items[0]!.dueDate = '2026-02-30'; return p; }, 'POWEROFFICE_DTO_INVALID'],
    ['not an object', 1, () => null, 'POWEROFFICE_DTO_INVALID'],
    ['class instance', 1, p => Object.assign(new (class Page {})(), p), 'POWEROFFICE_DTO_INVALID'],
    ['source failure', 2, () => { throw new Error('upstream 502 body: secret'); }, 'POWEROFFICE_SOURCE_FAILED'],
  ];
  for (const [label, target, mutate, expected] of cases) {
    const s = seam(async (call: SourceFaultCall) => {
      const page = clone(await call.builtIn()) as Page;
      if (call.ordinal === 1) firstId = page.items[0]!.id as string;
      return call.ordinal === target ? mutate(page) : page;
    });
    const error = await syncPowerOffice(prisma, s.composition, syncer, CA, 'po-reject').then(() => null, (e: Error & { code?: string; details?: unknown }) => e);
    assert.equal(error?.code, expected, label);
    assert.deepEqual([error?.message, error?.details], [expected, {}], `${label}: fixed code only, no detail`);
    assert.deepEqual(s.calls.map(c => c.ordinal), Array.from({ length: target }, (_, i) => i + 1), `${label}: stops at the failing page, no retry`);
    await closedPreserving(prior, expected, label);
  }
});

test('10 s per-page deadline: the in-flight call is aborted and the actual built-in refuses it; a late valid page is inert', async () => {
  const abortedConn = await published('po-slow-abort', 3);
  const lateConn = await published('po-slow-late', 3);
  const aborted = seam(async (call, log) => {
    await new Promise(resolve => call.control.signal.addEventListener('abort', resolve, { once: true }));
    log.outcome = `aborted@${Math.round(performance.now() - log.startedAt)}`;
    return call.builtIn().then(() => { log.outcome += ':builtin-page'; return null; }, () => { log.outcome += ':builtin-refused'; throw new Error('x'); });
  });
  const late = seam(async (call, log) => {
    const page = await call.builtIn(); // a valid page, obtained at once…
    await sleep(10_300); // …but delivered after the deadline
    log.outcome = `late:${call.control.signal.aborted}`;
    return page;
  });
  const started = performance.now();
  const [a, l] = await Promise.all([codeOf(syncPowerOffice(prisma, aborted.composition, syncer, CA, 'po-slow-abort')),
    codeOf(syncPowerOffice(prisma, late.composition, syncer, CA, 'po-slow-late'))]);
  assert.deepEqual([a, l], ['POWEROFFICE_DEADLINE', 'POWEROFFICE_DEADLINE']);
  assert.ok(performance.now() - started < 12_000, 'no window restarted');
  const [abortLog] = aborted.calls;
  assert.equal(aborted.calls.length, 1);
  const [, at, builtin] = /^aborted@(\d+):(builtin-\w+)$/.exec(abortLog!.outcome ?? '') ?? [];
  assert.ok(Number(at) >= 9_900 && Number(at) <= 10_500, `aborted at the 10 s page deadline (${abortLog!.outcome})`);
  assert.equal(builtin, 'builtin-refused', 'the actual built-in refuses an aborted control');
  assert.ok(abortLog!.monotonicDeadline - abortLog!.startedAt <= 10_000);
  await closedPreserving(abortedConn, 'POWEROFFICE_DEADLINE', 'aborted');
  await sleep(500);
  assert.deepEqual(late.calls.map(c => [c.ordinal, c.outcome]), [[1, 'late:true']], 'the late page arrived after the abort');
  await closedPreserving(lateConn, 'POWEROFFICE_DEADLINE', 'late result inert');
});
