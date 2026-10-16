import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { builtInExportPort, syntheticInvoiceCount } from '../connectors/poweroffice/builtin.ts';
import type { ExportSession, PageControl, SessionPins } from '../connectors/poweroffice/contract.ts';
import { ExportAccumulator } from '../packages/poweroffice/export.ts';
import { UUID_PATTERN } from '../packages/poweroffice/contracts.ts';
import { businessDate } from '../packages/poweroffice/calendar.ts';

// S4-B B1/B3: the ACTUAL built-in synthetic export port — deterministic complete pages, strict session/ordinal rules and its
// own cancellation (before work, at chunk boundaries while in flight, after work, deadline timer). No fault seam here.
const company = (hex12: string) => `synthetic-po-00000000-0000-4000-8000-${hex12}`;
const BIG = company('0000000000fa'); // 250 invoices: 100 + 100 + 50
const EMPTY = company('0000000000fb'); // 251 % 251 = 0
const ASOF = '2026-03-29T00:30:00.000Z'; // Oslo DST change day (01:30 local)
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const pins = (companyKey = BIG, over: Partial<SessionPins> = {}): SessionPins => ({ connectionId: 'po-a', companyKey, lifecycleVersion: 1, attemptId: ATTEMPT, asOf: ASOF, ...over });
const control = (ms = 10_000, signal = new AbortController().signal): PageControl => ({ signal, monotonicDeadline: performance.now() + ms });
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
type Page = { header: Record<string, unknown>; ordinal: number; items: Record<string, string>[]; hasMore: boolean };
async function allPages(companyKey: string, p = builtInExportPort(), over: Partial<SessionPins> = {}): Promise<Page[]> {
  const session = p.openSession(pins(companyKey, over));
  const pages: Page[] = [];
  for (let ordinal = 1; ; ordinal++) {
    const page = await p.readPage(session, ordinal, control()) as Page;
    pages.push(page);
    if (!page.hasMore) { p.closeSession(session); return pages; }
  }
}

test('size is chosen by the synthetic company UUID (last 12 hex digits mod 251); malformed keys refuse', () => {
  assert.equal(syntheticInvoiceCount(BIG), 250);
  assert.equal(syntheticInvoiceCount(EMPTY), 0);
  assert.equal(syntheticInvoiceCount(company('000000000001')), 1);
  assert.throws(() => syntheticInvoiceCount('cust-po-a'), /POWEROFFICE_SOURCE_FAILED/);
});

test('deterministic complete export: full pages, pinned header, valid DTOs accepted by the accepted ExportAccumulator; empty is one empty final page', async () => {
  const a = await allPages(BIG); const b = await allPages(BIG);
  assert.deepEqual(a, b, 'two independent ports, same pins → identical pages');
  assert.deepEqual(a.map(p => [p.ordinal, p.items.length, p.hasMore]), [[1, 100, true], [2, 100, true], [3, 50, false]]);
  for (const p of a) assert.deepEqual(p.header, { ...a[0]!.header });
  assert.equal(a[0]!.header.synthetic, true); assert.equal(a[0]!.header.companyKey, BIG); assert.equal(a[0]!.header.asOf, ASOF); assert.equal(a[0]!.header.totalCount, 250);
  const items = a.flatMap(p => p.items);
  assert.equal(new Set(items.map(i => i.id)).size, 250); assert.ok(items.every(i => UUID_PATTERN.test(i.id!)));
  assert.ok(items.some(i => i.kind === 'CREDIT_NOTE') && items.some(i => i.outstanding === '0.00') && items.some(i => i.dueDate! < businessDate(new Date(ASOF))));
  const acc = new ExportAccumulator({ companyKey: BIG, asOf: ASOF });
  assert.deepEqual(a.map(p => acc.accept(p)), [false, false, true]);
  assert.equal(acc.summary().totalCount, 250);
  const other = await allPages(BIG, builtInExportPort(), { attemptId: '22222222-2222-4222-8222-222222222222' });
  assert.notEqual(other[0]!.header.exportId, a[0]!.header.exportId, 'export ID derives from the attempt');
  const empty = await allPages(EMPTY);
  assert.deepEqual(empty.map(p => [p.ordinal, p.items.length, p.hasMore]), [[1, 0, false]]);
  const e = new ExportAccumulator({ companyKey: EMPTY, asOf: ASOF });
  assert.equal(e.accept(empty[0]), true); assert.deepEqual(e.summary(), { totalCount: 0, currencies: [] }, 'known empty, never null');
});

test('session rules: unknown/forged/closed sessions, repeated/out-of-order ordinals and a concurrent second call are refused', async () => {
  const p = builtInExportPort();
  for (const bad of [pins(BIG, { companyKey: 'synthetic-po-NOT' }), pins(BIG, { attemptId: 'x' }), pins(BIG, { asOf: '2026-03-29T00:30:00Z' }),
    pins(BIG, { lifecycleVersion: 0 }), pins(BIG, { connectionId: 'a,b' }), null as never]) assert.throws(() => p.openSession(bad), /POWEROFFICE_SOURCE_FAILED/);
  const forged = Object.freeze({ kind: 'PowerOfficeExportSession' as const }) as ExportSession;
  assert.equal(await code(p.readPage(forged, 1, control())), 'POWEROFFICE_SOURCE_FAILED', 'a fabricated session is unknown');
  const foreign = builtInExportPort().openSession(pins());
  assert.equal(await code(p.readPage(foreign, 1, control())), 'POWEROFFICE_SOURCE_FAILED', 'another port\'s session is unknown');
  const s = p.openSession(pins());
  assert.equal(await code(p.readPage(s, 2, control())), 'POWEROFFICE_SOURCE_FAILED', 'out of order');
  const first = p.readPage(s, 1, control());
  assert.equal(await code(p.readPage(s, 2, control())), 'POWEROFFICE_SOURCE_FAILED', 'no concurrent call while one is in flight');
  assert.equal(await code(first), 'ok');
  assert.equal(await code(p.readPage(s, 1, control())), 'POWEROFFICE_SOURCE_FAILED', 'an ordinal is never served twice');
  assert.equal(await code(p.readPage(s, 2, control())), 'ok');
  p.closeSession(s);
  assert.equal(await code(p.readPage(s, 3, control())), 'POWEROFFICE_SOURCE_FAILED', 'closed for good');
  for (const c of [null, {}, { signal: new AbortController().signal }, { signal: {}, monotonicDeadline: performance.now() + 1000 },
    { signal: new AbortController().signal, monotonicDeadline: Number.NaN }]) {
    assert.equal(await code(p.readPage(p.openSession(pins()), 1, c as never)), 'POWEROFFICE_SOURCE_FAILED');
  }
});

test('cancellation before work: an aborted signal or a passed deadline refuses and still consumes the ordinal', async () => {
  const p = builtInExportPort();
  const aborted = new AbortController(); aborted.abort();
  const s = p.openSession(pins());
  assert.equal(await code(p.readPage(s, 1, control(10_000, aborted.signal))), 'POWEROFFICE_SOURCE_FAILED');
  assert.equal(await code(p.readPage(s, 1, control())), 'POWEROFFICE_SOURCE_FAILED', 'no retry of the cancelled ordinal');
  const t = p.openSession(pins());
  assert.equal(await code(p.readPage(t, 1, { signal: new AbortController().signal, monotonicDeadline: performance.now() - 1 })), 'POWEROFFICE_SOURCE_FAILED');
});

test('in-flight cancellation: an abort between chunks, the deadline timer, a passed deadline at a chunk boundary and session close all reject; no page is ever delivered later', async () => {
  const p = builtInExportPort();
  // Abort after the first chunk ran (setImmediate order: the port's first step, then this abort).
  const c1 = new AbortController();
  const s1 = p.openSession(pins());
  let delivered = false;
  const inflight = p.readPage(s1, 1, control(10_000, c1.signal)).then(() => { delivered = true; return 'ok'; }, (e: { code?: string }) => e.code);
  setImmediate(() => c1.abort());
  assert.equal(await inflight, 'POWEROFFICE_SOURCE_FAILED');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(delivered, false, 'late completion never resolves an aborted call');
  // The deadline passes while the call is in flight: the synchronous busy wait keeps the event loop until after it.
  const s2 = p.openSession(pins());
  const deadline = p.readPage(s2, 1, control(2));
  const spin = performance.now() + 5; while (performance.now() < spin) { /* hold the loop past the deadline */ }
  assert.equal(await code(deadline), 'POWEROFFICE_SOURCE_FAILED');
  // The deadline passes after the first chunk already ran (in flight): the port's timer or its next boundary check rejects.
  const s3 = p.openSession(pins());
  const mid = code(p.readPage(s3, 1, control(3)));
  setImmediate(() => { const until = performance.now() + 5; while (performance.now() < until) { /* past the deadline mid-flight */ } });
  assert.equal(await mid, 'POWEROFFICE_SOURCE_FAILED');
  // Closing the session ends an in-flight call.
  const s4 = p.openSession(pins());
  const closing = code(p.readPage(s4, 1, control()));
  p.closeSession(s4);
  assert.equal(await closing, 'POWEROFFICE_SOURCE_FAILED');
  // A control that is never cancelled still completes normally afterwards (the port holds no global state).
  const s5 = p.openSession(pins());
  assert.equal(await code(p.readPage(s5, 1, control())), 'ok');
});

test('the connector has no network, credential, file, environment or process surface', async () => {
  const dir = new URL('../connectors/poweroffice/', import.meta.url);
  const files = (await readdir(dir)).filter(f => f.endsWith('.ts'));
  assert.deepEqual(files.sort(), ['builtin.ts', 'contract.ts']);
  for (const file of files) {
    const source = (await readFile(new URL(file, dir), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // code only
    for (const forbidden of [/\bfetch\s*\(/, /node:(http|https|http2|net|tls|dns|dgram|fs|child_process|worker_threads)/, /\bundici\b/, /process\.env/,
      /\brequire\s*\(/, /\bimport\s*\(/, /secretRef|resolveCredential|resolveSecret|oauth|bearer/i]) {
      assert.doesNotMatch(source, forbidden, `${file}: ${forbidden}`);
    }
  }
});
