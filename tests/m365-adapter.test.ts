import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM365SignInPage } from '../connectors/microsoft365/signin-dto.ts';
import { signInsUrl } from '../connectors/microsoft365/contract.ts';
import { retryDelayMs, signInVersion, splitBounds, windowPosition } from '../packages/m365/signin-rows.ts';
import { guid } from './m365-sql-invariants.ts';
import { signInRow } from './support/m365-graph-mock.ts';

// Stage 2 tasks 2.4/2.6, B6 (unit): Graph ge/le query versus Atlas's local half-open [from, to), exact-upper-bound rows,
// out-of-window rows, immutable version hashing, Retry-After above the generic backoff cap, bounded splitting.
const from = new Date('2026-10-08T10:00:00.000Z'); const to = new Date('2026-10-08T11:00:00.000Z');

test('the request asks Graph for the inclusive ge/le interval; Atlas keeps [from, to) locally with full source precision', () => {
  assert.equal(new URL(signInsUrl(from, to)).searchParams.get('$filter'), 'createdDateTime ge 2026-10-08T10:00:00.000Z and createdDateTime le 2026-10-08T11:00:00.000Z');
  const at = (t: string) => windowPosition(t, from, to);
  assert.equal(at('2026-10-08T10:00:00.000Z'), 'IN', 'lower bound inclusive');
  assert.equal(at('2026-10-08T10:59:59.9999999Z'), 'IN');
  assert.equal(at('2026-10-08T11:00:00.000Z'), 'UPPER_BOUND', 'exactly at `to`: validated and discarded');
  assert.equal(at('2026-10-08T11:00:00.0000001Z'), 'OUTSIDE', 'beyond `to` by 100ns: invalidates the attempt');
  assert.equal(at('2026-10-08T09:59:59.9999999Z'), 'OUTSIDE');
  assert.equal(at('2026-10-08T12:00:00.000Z'), 'OUTSIDE');
});

test('projection keeps only the allowlist; equal content deduplicates, any changed allowlisted value is a new version', () => {
  const [a] = parseM365SignInPage({ value: [signInRow('sig-1', '2026-10-08T10:15:00.1234567Z')] });
  const version = signInVersion(a!);
  assert.deepEqual(Object.keys(version.dto).sort(), ['appId', 'createdDateTime', 'deviceId', 'errorCode', 'id', 'isInteractive', 'userId']);
  assert.ok(!JSON.stringify(version).match(/203\.0\.113|DROP-ME|drop@example/), 'no IP, location, name/UPN or failure text');
  assert.equal(version.occurredAt.toISOString(), '2026-10-08T10:15:00.123Z', 'truncated to the stored millisecond, never rounded up');
  assert.equal(version.expiresAt.getTime() - version.occurredAt.getTime(), 7 * 24 * 3_600_000);
  const [same] = parseM365SignInPage({ value: [signInRow('sig-1', '2026-10-08T10:15:00.1234567Z', { ipAddress: '198.51.100.1' })] });
  assert.equal(signInVersion(same!).contentHash, version.contentHash, 'dropped fields never change the version');
  const [changed] = parseM365SignInPage({ value: [signInRow('sig-1', '2026-10-08T10:15:00.1234567Z', { status: { errorCode: 50126 } })] });
  assert.notEqual(signInVersion(changed!).contentHash, version.contentHash);
  const [otherDevice] = parseM365SignInPage({ value: [signInRow('sig-1', '2026-10-08T10:15:00.1234567Z', { deviceDetail: { deviceId: guid('3') } })] });
  assert.notEqual(signInVersion(otherDevice!).contentHash, version.contentHash);
  assert.match(version.contentHash, /^[0-9a-f]{64}$/);
});

test('retry delay: Retry-After honoured exactly even far above the 15-minute cap; otherwise bounded backoff with jitter', () => {
  assert.equal(retryDelayMs('M365_RATE_LIMITED', '3600', 1, 0), 3_600_000);
  assert.equal(retryDelayMs('M365_RATE_LIMITED', '7200', 5, 1), 7_200_000, 'not reduced to the generic 15m or Stage 1 1h cap');
  assert.equal(retryDelayMs('M365_RATE_LIMITED', undefined, 1, 0), 60_000);
  assert.equal(retryDelayMs('M365_RATE_LIMITED', undefined, 1, 1), 70_000, 'fallback plus bounded jitter');
  assert.equal(retryDelayMs('M365_UPSTREAM_UNAVAILABLE', undefined, 1, 0), 30_000);
  assert.equal(retryDelayMs('M365_UPSTREAM_UNAVAILABLE', undefined, 3, 0), 120_000);
  assert.equal(retryDelayMs('M365_UPSTREAM_UNAVAILABLE', undefined, 10, 1), 15 * 60_000, 'capped at 15 minutes');
});

test('splitting: two nonoverlapping halves of at least one minute; below two minutes a leaf is unsplittable', () => {
  const halves = splitBounds(from, to)!;
  assert.deepEqual(halves.map(h => h.map(d => d.toISOString())), [['2026-10-08T10:00:00.000Z', '2026-10-08T10:30:00.000Z'], ['2026-10-08T10:30:00.000Z', '2026-10-08T11:00:00.000Z']]);
  const two = splitBounds(from, new Date(from.getTime() + 120_000))!;
  assert.deepEqual(two.map(([a, b]) => b.getTime() - a.getTime()), [60_000, 60_000]);
  assert.equal(splitBounds(from, new Date(from.getTime() + 119_999)), null);
  const odd = splitBounds(from, new Date(from.getTime() + 125_001))!;
  assert.equal(odd[0][1].getTime(), odd[1][0].getTime(), 'no gap, no overlap');
  assert.ok(odd.every(([a, b]) => b.getTime() - a.getTime() >= 60_000));
});
