import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import type { Actor } from '../../packages/core/contracts.ts';
import { injectedCursorKey } from '../../packages/correlation/cursor.ts';
import { readCorrelation } from '../../packages/correlation/read.ts';
import type { CorrelationContextV1 } from '../../packages/correlation/contracts.ts';
import { claimRootAttempt, createM365SignInRequest } from '../../packages/m365/windows.ts';
import { DTO_TIME_SQL_PATTERN } from '../../packages/correlation/time.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { WS, gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, m365Actors } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { KARI, OTHER_DEVICE, OTHER_USER, REGISTRATION, addHuntressObservation, addReader, confirmLinks, confirmM365Links, publishScenarioDirectory, publishSignIns,
  readDeps, reader, signIn } from '../support/correlation-fixtures.ts';

// C4, C4b and cursor integrity (tests/pg/correlation-pages.pg.test.ts): coverage gap / stale / unavailable / complete-empty
// are distinct and never an all-clear; exact seven-digit keyset paging (sub-millisecond, non-ASCII source IDs) with a stable
// deduplicated total; the authenticated cursor refuses tampering, other input, changed publication/mapping/attempt state,
// Device.personId reassignment and appearing historical conflicts; current authority is rechecked on every page.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
const q = (sql: string, params: unknown[] = []) => pgdb.owner.query(sql, params);
await addReader(pgdb.owner);
const second: Actor = { ...reader, id: 'demo-m365-reader-2' }; const revoked: Actor = { ...reader, id: 'demo-m365-reader-3' };
await addReader(pgdb.owner, second); await addReader(pgdb.owner, revoked);
await confirmM365Links(pgdb.owner);
await publishScenarioDirectory(pgdb.owner);
await addHuntressObservation(pgdb.owner, 'obs-p');
const hour = (n: number) => hourStart(n); const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const P1 = hour(6); const EMPTY = hour(7); const STALE = hour(8); const UNCOLLECTED = hour(10);
const fraction = (d: Date, digits: string) => `${d.toISOString().slice(0, 20)}${digits}Z`;
const M = plus(P1, 10 * 60_000 + 5);
const unicode = ['😀', 'ｚ', '日本', 'é-1']; // JS UTF-16 order differs from code point (C collation) order for 😀 vs ｚ
let p1 = [...Array.from({ length: 8 }, (_, i) => signIn(`n-${i}`, iso(P1, (20 + i) * 60_000), OTHER_USER, REGISTRATION)),
  signIn('x-m', fraction(M, '005'), OTHER_USER, REGISTRATION), signIn('x-z', fraction(M, '0050001'), OTHER_USER, REGISTRATION),
  signIn('x-same-b', fraction(M, '0050005'), OTHER_USER, REGISTRATION), signIn('x-same-a', fraction(M, '0050005'), OTHER_USER, REGISTRATION),
  signIn('x-a', fraction(M, '0050009'), OTHER_USER, REGISTRATION), signIn('x-one-digit', fraction(plus(P1, 15 * 60_000), '5'), KARI, OTHER_DEVICE),
  ...unicode.map(id => signIn(id, iso(P1, 40 * 60_000), OTHER_USER, REGISTRATION)), signIn('n-unrelated', iso(P1, 50 * 60_000), OTHER_USER, OTHER_DEVICE)];
await publishSignIns(db, () => p1, P1, plus(P1, 3_600_000));
await publishSignIns(db, () => [], EMPTY, plus(EMPTY, 3_600_000));
await publishSignIns(db, () => [signIn('s-stale-1', iso(STALE, 60_000), KARI, REGISTRATION), signIn('s-stale-2', iso(STALE, 120_000), KARI, REGISTRATION),
  signIn('s-stale-3', iso(STALE, 180_000), KARI, REGISTRATION)], STALE, plus(STALE, 3_600_000), () => new Date(Date.now() - 20 * 60_000));
const read = (from: string | Date, to: string | Date, extra: Record<string, unknown> = {}, actor: Actor = reader, deps = readDeps()) =>
  readCorrelation(db, actor, gasta, { connectionId: M365_CONNECTION, observationId: 'obs-p', from: typeof from === 'string' ? from : from.toISOString(),
    to: typeof to === 'string' ? to : to.toISOString(), ...extra }, deps);
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const ids = (r: CorrelationContextV1) => r.items!.map(i => i.evidenceRef.sourceId);
async function all(from: Date, to: Date, limit: number): Promise<{ pages: string[][]; totals: number[] }> {
  const pages: string[][] = []; const totals: number[] = []; let cursor: string | undefined;
  do {
    const r = await read(from, to, { limit, ...(cursor ? { cursor } : {}) });
    pages.push(ids(r)); totals.push(r.total); cursor = r.nextCursor ?? undefined;
    assert.equal(r.truncated, cursor !== undefined);
  } while (cursor);
  return { pages, totals };
}

test('C4b: fully traversed retained interval after 15m is COMPLETE + traversalComplete + no gaps + STALE; none of it is an all-clear', async () => {
  const r = await read(STALE, plus(STALE, 3_600_000));
  assert.deepEqual([r.coverage.status, r.coverage.traversalComplete, r.coverage.gaps, r.coverage.freshness, r.resources[2]!.status],
    ['COMPLETE', true, [], 'STALE', 'STALE']);
  assert.deepEqual(r.coverage.completedWindows.map(w => w.freshness), ['STALE']);
  assert.equal(r.total, 3);
});
test('C4b: an actually uncovered interval is PARTIAL with its real gap; zero coverage is UNAVAILABLE with items null; complete zero matches is []', async () => {
  const partial = await read(plus(hour(9), 30 * 60_000), plus(STALE, 30 * 60_000));
  assert.deepEqual([partial.coverage.status, partial.coverage.traversalComplete, partial.coverage.gaps.map(g => [g.fromInclusive.slice(0, 19), g.toExclusive.slice(0, 19), g.reasonCode])],
    ['PARTIAL', false, [[plus(hour(9), 30 * 60_000).toISOString().slice(0, 19), STALE.toISOString().slice(0, 19), 'M365_WINDOW_NOT_COLLECTED']]]);
  assert.ok(Array.isArray(partial.items) && partial.items.length > 0, 'PARTIAL returns available items and the gap');
  const none = await read(UNCOLLECTED, plus(UNCOLLECTED, 3_600_000));
  assert.deepEqual([none.items, none.total, none.nextCursor, none.coverage.status, none.coverage.freshness, none.resources[2]!.status, none.resources[2]!.safeErrorCode],
    [null, 0, null, 'UNAVAILABLE', 'UNKNOWN', 'MISSING', 'M365_WINDOW_NOT_COLLECTED']);
  const empty = await read(EMPTY, plus(EMPTY, 3_600_000));
  assert.deepEqual([empty.items, empty.total, empty.coverage.status, empty.coverage.traversalComplete], [[], 0, 'COMPLETE', true]);
});
test('C4: keyset pages in occurredAt DESC, sourceId ASC (C collation) with a stable total equal to the single-page result', async () => {
  const whole = await read(P1, plus(P1, 3_600_000), { limit: 100 });
  const { pages, totals } = await all(P1, plus(P1, 3_600_000), 3);
  assert.deepEqual(pages.flat(), ids(whole));
  assert.ok(totals.every(t => t === whole.total) && whole.total === 18 && pages.length === 6);
  const byCodePoint = [...unicode].sort((a, b) => { const x = [...a].map(c => c.codePointAt(0)!); const y = [...b].map(c => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return x.length - y.length; });
  assert.deepEqual(ids(whole).filter(id => unicode.includes(id)), byCodePoint);
  assert.notDeepEqual(byCodePoint, [...unicode].sort(), 'the fixture really distinguishes code point from UTF-16 order');
  const single = await all(plus(P1, 40 * 60_000), plus(P1, 40 * 60_000 + 1), 1);
  assert.deepEqual(single.pages.flat(), byCodePoint, 'one item per page across the same instant follows the SQL order');
});
test('C4: exact seven-digit cuts inside one millisecond; 1- and 7-digit canonical fractions; occurredAt is the canonical DTO text', async () => {
  const r = await read(fraction(M, '0050005'), fraction(M, '0050009'));
  assert.deepEqual(ids(r), ['x-same-a', 'x-same-b']);
  assert.deepEqual(ids(await read(fraction(M, '005'), fraction(M, '0050006'))), ['x-same-a', 'x-same-b', 'x-z', 'x-m']);
  assert.deepEqual(ids(await read(fraction(M, '0050001'), fraction(M, '0050002'))), ['x-z']);
  const paged = await all(new Date(M.getTime()), new Date(M.getTime() + 1), 1);
  assert.deepEqual(paged.pages.flat(), ['x-a', 'x-same-a', 'x-same-b', 'x-z', 'x-m']);
  const items = (await read(P1, plus(P1, 3_600_000), { limit: 100 })).items!;
  assert.equal(items.find(i => i.evidenceRef.sourceId === 'x-a')!.occurredAt, fraction(M, '0050009'));
  assert.equal(items.find(i => i.evidenceRef.sourceId === 'x-m')!.occurredAt, fraction(M, '005'));
  assert.equal(items.find(i => i.evidenceRef.sourceId === 'x-one-digit')!.occurredAt, fraction(plus(P1, 15 * 60_000), '500'), 'one input digit, canonical ≥3');
  assert.deepEqual([r.window.fromInclusive, r.window.toExclusive], [fraction(M, '0050005'), fraction(M, '0050009')]);
});
test('C4: a tampered, foreign-key or malformed cursor is CORRELATION_CURSOR_INVALID; other input or another actor is CORRELATION_CHANGED', async () => {
  const page = await read(P1, plus(P1, 3_600_000), { limit: 2 });
  const cursor = page.nextCursor!;
  const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  for (const bad of [flip(cursor, cursor.length - 2), flip(cursor, 5), `${cursor.split('.')[0]}.${'A'.repeat(43)}`, `x${cursor}`.slice(0, 600), 'not-a-cursor']) {
    await assert.rejects(read(P1, plus(P1, 3_600_000), { limit: 2, cursor: bad }), fails('CORRELATION_CURSOR_INVALID'));
  }
  await assert.rejects(read(P1, plus(P1, 3_600_000), { limit: 2, cursor }, reader, { cursorKey: () => injectedCursorKey('another-synthetic-secret-of-thirty-two-bytes!') }),
    fails('CORRELATION_CURSOR_INVALID'));
  await assert.rejects(read(P1, plus(P1, 3_600_000), { limit: 3, cursor }), fails('CORRELATION_CHANGED'));
  await assert.rejects(read(P1, plus(P1, 3_599_000), { limit: 2, cursor }), fails('CORRELATION_CHANGED'));
  await assert.rejects(read(P1, plus(P1, 3_600_000), { limit: 2, cursor }, second), fails('CORRELATION_CHANGED'));
  assert.deepEqual(ids(await read(P1, plus(P1, 3_600_000), { limit: 2, cursor })).length, 2, 'the untouched cursor still pages');
});
test('C4: mapping, Device.personId reassignment/removal, publication and an appearing historical conflict version between pages → CORRELATION_CHANGED', async () => {
  const fresh = async () => (await read(P1, plus(P1, 3_600_000), { limit: 2 })).nextCursor!;
  const next = (cursor: string) => read(P1, plus(P1, 3_600_000), { limit: 2, cursor });
  let cursor = await fresh();
  await q(`UPDATE "EntityLink" SET status = 'REJECTED', "reasonCode" = 'MANUAL_REJECT' WHERE id = 'link-m365-user'`);
  await assert.rejects(next(cursor), fails('CORRELATION_CHANGED'), 'a user mapping change (no item of page 2 depends on it) still invalidates');
  await confirmLinks(pgdb.owner, 'link-m365-user');
  cursor = await fresh();
  await q(`UPDATE "Device" SET "personId" = 'demo-ola' WHERE id = 'demo-device-07'`);
  await assert.rejects(next(cursor), fails('CORRELATION_CHANGED'), 'reassignment with otherwise unchanged links');
  await q(`UPDATE "Device" SET "personId" = 'demo-kari' WHERE id = 'demo-device-07'`);
  cursor = await fresh();
  await q(`UPDATE "Device" SET "personId" = NULL WHERE id = 'demo-device-07'`);
  await assert.rejects(next(cursor), fails('CORRELATION_CHANGED'), 'removal');
  await q(`UPDATE "Device" SET "personId" = 'demo-kari' WHERE id = 'demo-device-07'`);
  cursor = await fresh();
  await q(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'demo-huntress-connection'`);
  await assert.rejects(next(cursor), fails('CORRELATION_CHANGED'), 'the historical Huntress source connection state is an input');
  await q(`UPDATE "Connection" SET status = 'FIXTURE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'demo-huntress-connection'`);
  cursor = await fresh();
  await q(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [M365_CONNECTION]);
  await assert.rejects(next(cursor), fails('CORRELATION_CHANGED'), 'a new lifecycle version of the selected M365 connection');
  cursor = await fresh();
  await publishSignIns(db, () => [signIn('n-3', iso(hour(11), 60_000), OTHER_USER, OTHER_DEVICE)], hour(11), plus(hour(11), 3_600_000));
  await assert.rejects(next(cursor), fails('CORRELATION_CHANGED'), 'a published version of a selected ID appears outside the interval');
  cursor = await fresh();
  p1 = [...p1, signIn('n-new', iso(P1, 55 * 60_000), OTHER_USER, REGISTRATION)];
  await publishSignIns(db, () => p1, P1, plus(P1, 3_600_000));
  await assert.rejects(next(cursor), fails('CORRELATION_CHANGED'), 'a new publication of the root');
});
test('C4: a newer started attempt (latest attempt state) invalidates; the position must be in the reloaded eligible selection', async () => {
  const cursor = (await read(STALE, plus(STALE, 3_600_000), { limit: 1 })).nextCursor!;
  const request = await createM365SignInRequest(db, m365Actors.syncer, gasta, M365_CONNECTION, STALE, plus(STALE, 3_600_000));
  const claim = await claimRootAttempt(db, m365Actors.syncer, gasta, M365_CONNECTION, request.requestId, request.roots[0]!.windowId);
  assert.ok('claimed' in claim);
  await assert.rejects(read(STALE, plus(STALE, 3_600_000), { limit: 1, cursor }), fails('CORRELATION_CHANGED'));
});
test('C4: current authority is rechecked on every page: a revoke between pages denies with exactly one workspace denial and no client audit', async () => {
  const cursor = (await read(P1, plus(P1, 3_600_000), { limit: 2 }, revoked)).nextCursor!;
  await q(`UPDATE "ClientMembership" SET permissions = '{context:read}' WHERE "actorId" = $1`, [revoked.id]);
  await assert.rejects(read(P1, plus(P1, 3_600_000), { limit: 2, cursor }, revoked), fails('PERMISSION_DENIED'));
  assert.deepEqual((await q(`SELECT "eventType", "requestedClientId", "reasonCode", metadata FROM "SecurityAuditEvent" WHERE "actorId" = $1`, [revoked.id])).rows,
    [{ eventType: 'correlation.read_denied', requestedClientId: 'demo-gasta', reasonCode: 'PERMISSION_DENIED', metadata: {} }]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "actorId" = $1`, [revoked.id])).rows[0].n, 1, 'only the first, permitted page');
  await q(`UPDATE "ClientMembership" SET permissions = '{context:read,m365:read}' WHERE "actorId" = $1`, [revoked.id]);
  await q(`UPDATE "Actor" SET status = 'DISABLED' WHERE id = $1`, [revoked.id]);
  await assert.rejects(read(P1, plus(P1, 3_600_000), {}, revoked), fails('PERMISSION_DENIED'), 'an inactive actor is refused at the next request');
});
test('C4: the read SQL guard accepts only canonical stored DTO times (3..7 digits, Z); anything else is excluded, never a raw error', async () => {
  const rows = (await q(`SELECT v, v ~ $1 AS ok FROM unnest($2::text[]) v`, [DTO_TIME_SQL_PATTERN, ['2026-10-08T10:00:00.005Z', '2026-10-08T10:00:00.1234567Z',
    '2026-10-08T10:00:00Z', '2026-10-08T10:00:00.12Z', '2026-10-08T10:00:00.12345678Z', '2026-10-08T10:00:00.123+00:00', 'garbage']])).rows;
  assert.deepEqual(rows.map(r => r.ok), [true, true, false, false, false, false, false]);
});
test('C4: interval input is rejected, never clipped: future end, older than 7 days, over 24h, from >= to, unknown or repeated keys', async () => {
  await assert.rejects(read(plus(new Date(), -60_000), plus(new Date(), 60_000)), fails('CORRELATION_INTERVAL_FUTURE'));
  await assert.rejects(read(plus(new Date(), -7 * 86_400_000 - 60_000), plus(new Date(), -7 * 86_400_000 + 3_600_000)), fails('CORRELATION_INTERVAL_NOT_RETAINED'));
  await assert.rejects(read(plus(P1, -86_400_001), P1), fails('INVALID_READ_PARAMETERS'));
  await assert.rejects(read(P1, P1), fails('INVALID_READ_PARAMETERS'));
  await assert.rejects(read(P1, plus(P1, 60_000), { tenantId: 'x' }), fails('INVALID_READ_PARAMETERS'));
  await assert.rejects(read(P1, plus(P1, 60_000), { limit: [1, 2] }), fails('INVALID_READ_PARAMETERS'));
  await assert.rejects(read(P1, plus(P1, 60_000), { limit: 101 }), fails('INVALID_READ_PARAMETERS'));
  await assert.rejects(read('2026-02-30T00:00:00Z', plus(P1, 60_000)), fails('INVALID_READ_PARAMETERS'));
});
test('C4: a deliberately unavailable sign-in capability is MISSING + M365_SIGNINS_NOT_AVAILABLE with UNAVAILABLE coverage, never complete-empty', async () => {
  await q(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType",status,"safeErrorCode","lastAttemptAt") VALUES ($1,'demo-gasta',$2,'m365_signin',
    'UNAVAILABLE','M365_SIGNINS_NOT_AVAILABLE',now())`, [WS, M365_CONNECTION]);
  const r = await read(EMPTY, plus(EMPTY, 3_600_000));
  assert.deepEqual([r.items, r.total, r.coverage.status, r.coverage.gaps.map(g => g.reasonCode), r.resources[2]!.status, r.resources[2]!.safeErrorCode],
    [null, 0, 'UNAVAILABLE', ['M365_SIGNINS_NOT_AVAILABLE'], 'MISSING', 'M365_SIGNINS_NOT_AVAILABLE']);
});
