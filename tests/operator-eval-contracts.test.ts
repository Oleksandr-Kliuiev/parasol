import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { decodeHandoffRequest, decodePair200, HANDOFF_V1 as SERVER_HANDOFF_V1, PAIR200_CAP as SERVER_PAIR200_CAP, RESPONSE_BODY_CAP as SERVER_RESPONSE_CAP }
  from '../packages/reval/eval-handoff-dto.ts';
import { FAILURE_CODES } from '../packages/reval/codes.ts';
import { RECEIPT_HEADER as SERVER_RECEIPT, SESSION_HEADER as SERVER_SESSION } from '../packages/reval/eval-gate.ts';
import { isToken } from '../packages/reval/eval-wire.ts';
import { HANDOFF_V1, PAIR200_CAP, RECEIPT_HEADER, RESPONSE_BODY_CAP, SESSION_HEADER, TOKEN_PATTERN, handoffPath, pairBody, receiptOf, responseBody,
  validatePair200 } from '../apps/operator/measured/eval-contracts.ts';
import { HANDOFF_CODES } from '../apps/operator/measured/eval-transport.ts';
import { focusOf, pair200 } from './support/operator-eval.ts';

// RS-C-C browser copies of the evaluation handoff contracts (rs-c brief C §3): parity with the ACCEPTED server DTOs/codes/headers
// (packages/reval, imported read-only), exact PAIR200 validation, canonical tokens only, and RESPONSE/PAIR bodies the server's own
// strict decoder accepts. Pure; synthetic values.
const raw = (b: Buffer) => b.toString('base64url');

test('parity: version, caps, header names and the closed failure-code list equal the accepted server constants', () => {
  assert.deepEqual([HANDOFF_V1, PAIR200_CAP, RESPONSE_BODY_CAP], [SERVER_HANDOFF_V1, SERVER_PAIR200_CAP, SERVER_RESPONSE_CAP]);
  assert.equal(SESSION_HEADER.toLowerCase(), SERVER_SESSION.toLowerCase()); assert.equal(RECEIPT_HEADER, SERVER_RECEIPT);
  assert.deepEqual([...HANDOFF_CODES], [...FAILURE_CODES]);
});

test('token pattern = the server Token rule (canonical 256-bit base64url only)', () => {
  for (let i = 0; i < 300; i += 1) { const t = raw(randomBytes(32)); assert.equal(TOKEN_PATTERN.test(t), true); assert.equal(isToken(t), true); }
  for (const bad of [raw(randomBytes(32)).slice(0, 42) + 'B', raw(randomBytes(31)), raw(randomBytes(33)), 'a'.repeat(43) + '=', ` ${raw(randomBytes(32))}`]) {
    assert.equal(TOKEN_PATTERN.test(bad), isToken(bad), bad);
  }
});

test('PAIR200: the whole valid body (NONE/FOUND/MISSING) or nothing; every server-rejected shape is rejected here too', () => {
  for (const focus of [focusOf('NONE'), focusOf('FOUND', 'syn-obs-b2'), focusOf('MISSING', 'syn-obs-not-found')]) {
    const body = pair200(focus);
    assert.doesNotThrow(() => decodePair200(body));
    const v = validatePair200(body);
    assert.deepEqual([v.sessionToken, v.pair.pairId, v.pair.focus], [body.sessionToken, body.pairId, focus]);
    assert.ok(!JSON.stringify(v.pair).includes(body.sessionToken), 'the session token is never part of the safe pair view');
  }
  const bad: [string, unknown][] = [
    ['extra key', { ...pair200(focusOf('NONE')), extra: 1 }], ['NONE with an ID', pair200({ ...focusOf('NONE'), requestedFocus: 'x' })],
    ['FOUND without ID', pair200({ ...focusOf('FOUND', 'x'), requestedFocus: null })], ['bad fixture', pair200({ ...focusOf('NONE'), fixtureId: 'FX12' })],
    ['bad time', pair200(focusOf('NONE'), { expiresAt: '2026-10-10T08:00:00Z' })], ['non-canonical token', pair200(focusOf('NONE'), { sessionToken: 'a'.repeat(42) + 'B' })],
    ['bad state', pair200({ ...focusOf('NONE'), focusState: 'MAYBE' as never })], ['generation 0', pair200({ ...focusOf('NONE'), fixtureGeneration: '0' })],
    ['uppercase UUID', pair200(focusOf('NONE'), { pairId: randomUUID().toUpperCase() })], ['array', []], ['null', null]];
  for (const [name, value] of bad) {
    assert.throws(() => validatePair200(value), name);
    assert.throws(() => decodePair200(value), `the server rejects it too: ${name}`);
  }
});

test('PAIR and RESPONSE bodies are exactly what the server decoder accepts; malformed input sends nothing; receipt header must be one canonical Token', () => {
  const nonce = raw(randomBytes(32));
  assert.deepEqual(decodeHandoffRequest(JSON.parse(pairBody(nonce)!)), { contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: nonce });
  assert.equal(pairBody(` ${nonce}`), null, 'never trimmed'); assert.equal(pairBody('x'), null);
  const values = { pairId: randomUUID(), receiptNonce: raw(randomBytes(32)), request: { contractVersion: 'AskRequestV2', q: 'x' },
    response: { status: 200, correlationId: randomUUID(), body: { contractVersion: 'AskAnswerV2' } } };
  const decoded = decodeHandoffRequest(JSON.parse(responseBody(values)!));
  assert.equal(decoded.operation, 'RESPONSE');
  assert.equal(responseBody({ ...values, receiptNonce: 'short' }), null);
  assert.equal(responseBody({ ...values, request: { big: 'x'.repeat(RESPONSE_BODY_CAP) } }), null, 'over 288 KiB: rejected, never truncated');
  assert.equal(receiptOf(new Headers({ 'x-atlas-evaluation-receipt': values.receiptNonce })), values.receiptNonce);
  assert.equal(receiptOf(new Headers({ 'x-atlas-evaluation-receipt': `${values.receiptNonce}, ${values.receiptNonce}` })), null);
  assert.equal(receiptOf(new Headers()), null);
  assert.equal(handoffPath('c-db'), '/clients/c-db/ask/evaluation-handoff'); assert.equal(handoffPath('../x'), null);
});
