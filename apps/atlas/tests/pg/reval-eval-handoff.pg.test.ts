import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { decodeTransfer } from '../../packages/reval/eval-transient.ts';
import type { Transfer } from '../../packages/reval/eval-transient.ts';
import { newToken } from '../../packages/reval/eval-wire.ts';
import { revise } from '../support/ask-remote-pg.ts';
import { answerResult } from '../support/reval-eval-fixtures.ts';
import { WS } from '../support/reval-fixture-pg.ts';
import { browserHeaders, evalSandbox, handoffPath, pairAndArm, post, question, respond, startEvalServer } from '../support/reval-eval-server.ts';
import type { Armed, EvalServer } from '../support/reval-eval-server.ts';

// R-EVAL RS-C-A browser RESPONSE handoff and the S<->I transient transfer on Docker PG17 (rs-c/IMPLEMENTATION_BRIEF.md §5;
// 04 "The server must bind the actual values"; 06 "Exact transient transfer and acknowledgements"). After a real answered
// case: edited/swapped DTOs never transfer; the receipt nonce is one-use and race-safe; Origin/Fetch-Metadata/session/bearer are
// enforced before anything is compared; a forged, late or rejecting ACK never COMMITs; losing I after TRANSFER is UNVERIFIED.
const sb = await evalSandbox();
const servers: EvalServer[] = [];
after(async () => { for (const s of servers) await s.close().catch(() => undefined); await sb.ns.cleanup(); });
async function answered(): Promise<{ srv: EvalServer; a: Armed; q: Awaited<ReturnType<typeof question>> }> {
  const srv = await startEvalServer(sb); servers.push(srv);
  const a = await pairAndArm(srv, sb);
  const q = await question(srv, sb, a);
  assert.equal(q.res.status, 200, q.res.body);
  return { srv, a, q };
}
const code = (r: { status: number; body: string }) => `${r.status} ${r.body ? JSON.parse(r.body).code : ''}`;
/** Nothing more arrives on the instrument's handoff connection within `ms` (no TRANSFER / COMMIT was sent). */
async function silent(a: Armed, ms = 300): Promise<boolean> { return a.ho.next(ms).then(() => false, (e: { reason?: string }) => e.reason === 'TIMEOUT'); }
const ackFor = (t: Transfer, over: Record<string, unknown> = {}) => ({ contractVersion: 'RevalTransientAckV1', challenge: t.ackChallenge, transferSequence: t.sequence,
  transferId: t.transferId, binding: t.binding, commitChallenge: randomUUID(), disposition: 'ACCEPTED', result: answerResult, failureCode: null, ...over });

test('edited request / swapped response body / edited status or correlation → CONTENT_MISMATCH with no TRANSFER; the slot burns', async () => {
  for (const edit of [(b: any) => ({ request: { ...b.request, question: `${b.request.question}!` } }),
    (b: any) => ({ response: { ...b.response, body: { ...b.response.body, status: 'INSUFFICIENT' } } }),
    (b: any) => ({ response: { ...b.response, status: 503 } }), (b: any) => ({ response: { ...b.response, correlationId: randomUUID() } })]) {
    const { srv, a, q } = await answered();
    const base = { request: q.body, response: { status: q.res.status, correlationId: q.res.headers['x-atlas-correlation-id'], body: JSON.parse(q.res.body) } };
    const r = await respond(srv, sb, a, q, edit(base));
    assert.equal(code(r), '503 CONTENT_MISMATCH');
    assert.ok(await silent(a), 'no TRANSFER for a mismatch');
    assert.equal(code(await respond(srv, sb, a, q)), '503 RAW_EXPIRED', 'the exact values can no longer be handed off');
  }
});

test('receipt nonce: a wrong nonce never burns the slot; two concurrent correct RESPONSEs → exactly one transfer; replay after COMMIT → RAW_EXPIRED', async () => {
  const { srv, a, q } = await answered();
  assert.equal(code(await respond(srv, sb, a, q, { receiptNonce: newToken() })), '503 RAW_EXPIRED');
  assert.equal(srv.runtime.state.slot.state, 'AVAILABLE');
  const both = [respond(srv, sb, a, q), respond(srv, sb, a, q)];
  const t = decodeTransfer(await a.ho.next());
  a.ho.send(ackFor(t));
  assert.equal((await a.ho.next()).disposition, 'COMMITTED');
  const statuses = (await Promise.all(both)).map(code).sort();
  assert.deepEqual(statuses, ['204 ', '503 RAW_EXPIRED']);
  assert.ok(await silent(a), 'one TRANSFER only');
  assert.equal(code(await respond(srv, sb, a, q)), '503 RAW_EXPIRED');
});

test('Origin / Fetch-Metadata / session header / bearer are enforced before any comparison; a foreign bearer revokes the pair', async () => {
  const { srv, a, q } = await answered();
  for (const [h, want] of [[{ origin: 'http://evil.test' }, '400 PROTOCOL_INVALID'], [{ 'sec-fetch-site': 'cross-site' }, '400 PROTOCOL_INVALID'],
    // RS-C-C (review rc1 F1): the measured console's accepted Host gate now runs first on every path: a wrong Host is 421.
    [{ host: 'localhost' }, '421 '], [{ 'x-atlas-evaluation-session': newToken() }, '401 UNAUTHORIZED'],
    [{ 'content-type': 'text/plain' }, '400 PROTOCOL_INVALID']] as const) {
    const r = await respond(srv, sb, a, q, {}, h as Record<string, string>);
    assert.equal(r.status === 421 ? '421 ' : code(r), want, JSON.stringify(h)); // 421 is the accepted plain-text Host refusal
  }
  assert.equal(srv.runtime.state.slot.state, 'AVAILABLE', 'header refusals never touch the slot');
  const session = { 'x-atlas-evaluation-session': a.sessionToken };
  const dup = `{"contractVersion":"RevalBrowserHandoffV1","operation":"RESPONSE","operation":"RESPONSE","pairId":"${a.pairId}"}`;
  assert.equal(code(await post(srv.port, handoffPath, dup, browserHeaders(srv.port, sb.tokens.actor, session))), '400 PROTOCOL_INVALID', 'duplicate keys');
  const badUtf8 = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = Buffer.concat([Buffer.from('{"contractVersion":"RevalBrowserHandoffV1","operation":"PAIR","pairingNonce":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
    const r = httpRequest({ host: '127.0.0.1', port: srv.port, path: handoffPath, method: 'POST', setHost: false, agent: false,
      headers: { ...browserHeaders(srv.port, sb.tokens.actor), 'content-length': String(body.length) } }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject); r.end(body);
  });
  assert.equal(code(badUtf8), '400 PROTOCOL_INVALID', 'fatal UTF-8');
  assert.equal(srv.runtime.state.slot.state, 'AVAILABLE', 'malformed bodies never touch the slot');
  const big = await post(srv.port, handoffPath, 'x'.repeat(288 * 1024 + 1), browserHeaders(srv.port, sb.tokens.actor, { 'x-atlas-evaluation-session': a.sessionToken }));
  assert.equal(code(big), '413 FRAME_TOO_LARGE');
  const foreign = await post(srv.port, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: a.pairId,
    receiptNonce: q.res.headers['x-atlas-evaluation-receipt'], request: q.body,
    response: { status: 200, correlationId: q.res.headers['x-atlas-correlation-id'], body: JSON.parse(q.res.body) } }),
    browserHeaders(srv.port, sb.tokens.other, { 'x-atlas-evaluation-session': a.sessionToken }));
  assert.equal(code(foreign), '403 SCOPE_MISMATCH');
  // rc2 F6: an authority denial detected at use revokes the PAIR (not only the slot): the session token is dead.
  assert.equal(srv.runtime.state.pair.state, 'ENDED');
  assert.equal(code(await respond(srv, sb, a, q)), '401 UNAUTHORIZED', 'revoked by the foreign bearer');
  assert.equal(srv.runtime.state.rawRetained(), false);
  assert.ok(await silent(a));
});

test('forged ACK (wrong challenge) → ACK_INVALID, no COMMIT; a REJECTED ACK → COMMIT FAILED; a late ACK → DEADLINE and is dropped', async () => {
  { const { srv, a, q } = await answered();
    const h = respond(srv, sb, a, q); const t = decodeTransfer(await a.ho.next());
    a.ho.send(ackFor(t, { challenge: randomUUID() }));
    assert.equal(code(await h), '503 ACK_INVALID'); assert.ok(await silent(a), 'no COMMIT for a forged ACK'); }
  { const { srv, a, q } = await answered();
    const h = respond(srv, sb, a, q); const t = decodeTransfer(await a.ho.next());
    a.ho.send(ackFor(t, { disposition: 'REJECTED', result: null, failureCode: 'VALUE_VALIDATION_FAILED' }));
    const commit = await a.ho.next();
    assert.deepEqual([commit.disposition, commit.failureCode], ['FAILED', 'ACK_INVALID']);
    assert.equal(code(await h), '503 VALUE_VALIDATION_FAILED'); }
  { const { srv, a, q } = await answered();
    const h = respond(srv, sb, a, q); const t = decodeTransfer(await a.ho.next());
    assert.equal(code(await h), '504 DEADLINE', 'one 2 s deadline from the browser POST');
    a.ho.send(ackFor(t));
    assert.ok(await silent(a, 500), 'a late ACK is dropped: no COMMIT'); }
});

test('losing the instrument after TRANSFER → IPC_LOST (UNVERIFIED) and the pair is revoked; an out-of-sequence ACK closes the connection', async () => {
  { const { srv, a, q } = await answered();
    const h = respond(srv, sb, a, q); decodeTransfer(await a.ho.next());
    a.ho.channel.close();
    assert.equal(code(await h), '503 IPC_LOST');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(srv.runtime.state.pair.state, 'ENDED'); assert.equal(srv.runtime.state.isSessionToken(a.sessionToken), false); }
  { const { srv, a, q } = await answered();
    const h = respond(srv, sb, a, q); const t = decodeTransfer(await a.ho.next());
    a.ho.send(ackFor(t), '7');
    assert.equal(code(await h), '503 IPC_LOST');
    assert.equal(srv.runtime.state.pair.state, 'ENDED'); }
});

test('rc2 F4: a RESPONSE body completed after the 2 s handoff deadline → 504 DEADLINE before any comparison or TRANSFER', async () => {
  const { srv, a, q } = await answered();
  const text = JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: a.pairId, receiptNonce: q.res.headers['x-atlas-evaluation-receipt'],
    request: q.body, response: { status: 200, correlationId: q.res.headers['x-atlas-correlation-id'], body: JSON.parse(q.res.body) } });
  const late = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port: srv.port, path: handoffPath, method: 'POST', setHost: false, agent: false,
      headers: browserHeaders(srv.port, sb.tokens.actor, { 'x-atlas-evaluation-session': a.sessionToken }, Buffer.byteLength(text)) }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', () => resolve({ status: 0, body: '' })); void reject;
    r.flushHeaders(); setTimeout(() => r.end(text), 2500);
  });
  assert.equal(code(late), '504 DEADLINE');
  assert.ok(await silent(a), 'no TRANSFER after the deadline');
  assert.equal(srv.runtime.state.slot.state, 'AVAILABLE', 'the receipt was never claimed');
});

test('rc2 F6: a policy paused after the answer → RESPONSE refused and the PAIR revoked; another current token of the same actor → PAIR_REVOKED', async () => {
  { const { srv, a, q } = await answered();
    await revise(sb.ns.db.owner, WS, { state: 'PAUSED' });
    try {
      assert.equal(code(await respond(srv, sb, a, q)), '503 ADMISSION_NOT_ACTIVE');
      assert.ok(await silent(a));
      assert.equal(srv.runtime.state.pair.state, 'ENDED', 'revoked, not only the slot');
    } finally { sb.policyVersion = await revise(sb.ns.db.owner, WS, { state: 'ACTIVE' }); } }
  { const { srv, a, q } = await answered();
    const other = await post(srv.port, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: a.pairId,
      receiptNonce: q.res.headers['x-atlas-evaluation-receipt'], request: q.body,
      response: { status: 200, correlationId: q.res.headers['x-atlas-correlation-id'], body: JSON.parse(q.res.body) } }),
    browserHeaders(srv.port, sb.tokens.actor2, { 'x-atlas-evaluation-session': a.sessionToken }));
    assert.equal(code(other), '503 PAIR_REVOKED', 'the pair is bound to its pairing credential');
    assert.equal(srv.runtime.state.pair.state, 'ENDED');
    assert.equal(code(await respond(srv, sb, a, q)), '401 UNAUTHORIZED', 'the session token died with the pair');
    assert.ok(await silent(a)); }
});
