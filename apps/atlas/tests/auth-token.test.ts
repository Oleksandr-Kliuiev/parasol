import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEARER_TOKEN_PATTERN, generateToken, hashToken, parseBearerToken } from '../packages/auth/token.ts';

test('bearer parsing accepts only a well-formed token and rejects everything else before any database work', () => {
  const token = generateToken();
  assert.match(token, BEARER_TOKEN_PATTERN);
  assert.equal(parseBearerToken(`Bearer ${token}`), token);
  assert.equal(parseBearerToken(`bearer ${token}`), token, 'scheme is case-insensitive (RFC 7235)');
  for (const header of [undefined, '', token, `Basic ${token}`, 'Bearer short', `Bearer ${token} extra`, `Bearer  ${token}`,
    `Bearer ${'x'.repeat(300)}`, `Bearer ${token.slice(0, 10)}'; DROP TABLE "ApiToken";--`, ['Bearer', token]]) {
    assert.equal(parseBearerToken(header), null, String(header).slice(0, 40));
  }
});

test('only a SHA-256 hex digest represents a token; equal tokens hash equal, different tokens differ', () => {
  const token = generateToken();
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), hashToken(generateToken()));
  assert.ok(!hashToken(token).includes(token));
});
