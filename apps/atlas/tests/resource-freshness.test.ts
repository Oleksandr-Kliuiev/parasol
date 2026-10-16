import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapResources, mapClientContext, RESOURCE_MAX_AGE_MS } from '../packages/graph/context-mapper.ts';
import type { DbConnectionRow, DbSyncStateRow } from '../packages/graph/context-mapper.ts';
import { scope } from '../fixtures/gasta.ts';

// Task 1.5 freshness rules with an explicit clock: what a ResourceView says about a snapshot and its last refresh.
const now = new Date('2026-10-07T08:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const item = { source: 'huntress', resourceType: 'incident', externalId: '9001', title: 'Synthetic', status: 'sent', severity: 'CRITICAL',
  priority: null, device: null, occurredAt: null, updatedAt: null };
const state = (resourceType: string, status: string, code: string | null, snapshotAgeMinutes: number | null): DbSyncStateRow => ({
  resourceType, status, safeErrorCode: code, lastSyncAt: ago(1), lastSuccessAt: snapshotAgeMinutes === null ? null : ago(snapshotAgeMinutes),
  snapshot: snapshotAgeMinutes === null ? null : { asOf: ago(snapshotAgeMinutes), items: [item], itemCount: 3, truncated: true } });
const connection = (system: string, syncStates: DbSyncStateRow[]): DbConnectionRow => ({ id: `c-${system}`, system, status: 'ACTIVE', syncStates });
const one = (system: string, s: DbSyncStateRow) => mapResources([connection(system, [s])], now).find(v => v.resourceType === s.resourceType)!;

test('OK only for a fresh snapshot after a successful refresh; STALE by age or after a failed refresh; ERROR without any complete read; MISSING when not read', () => {
  assert.deepEqual(RESOURCE_MAX_AGE_MS, { alert: 900_000, incident: 900_000, ticket: 1_800_000 });
  const fresh = one('huntress', state('incident', 'OK', null, 5));
  assert.deepEqual([fresh.status, fresh.safeErrorCode, fresh.items?.length, fresh.truncated, fresh.asOf], ['OK', null, 1, true, ago(5).toISOString()]);
  const old = one('huntress', state('incident', 'OK', null, 16));
  assert.deepEqual([old.status, old.safeErrorCode, old.items?.length], ['STALE', 'SNAPSHOT_STALE', 1], 'older than the window: shown with asOf, not as current');
  const failed = one('huntress', state('incident', 'ERROR', 'UPSTREAM_UNAVAILABLE', 5));
  assert.deepEqual([failed.status, failed.safeErrorCode, failed.items?.length, failed.lastSuccessAt], ['STALE', 'UPSTREAM_UNAVAILABLE', 1, ago(5).toISOString()]);
  const never = one('huntress', state('incident', 'ERROR', 'UPSTREAM_AUTH_FAILED', null));
  assert.deepEqual([never.status, never.safeErrorCode, never.items], ['ERROR', 'UPSTREAM_AUTH_FAILED', null]);
  const pending = one('huntress', state('incident', 'PENDING', null, null));
  assert.deepEqual([pending.status, pending.safeErrorCode, pending.items], ['MISSING', 'SYNC_NOT_COMPLETED', null], 'a first read began, no outcome yet');
  const unavailable = one('atera', state('alert', 'UNAVAILABLE', 'UPSTREAM_TENANT_FILTER_UNAVAILABLE', null));
  assert.deepEqual([unavailable.status, unavailable.safeErrorCode, unavailable.items], ['MISSING', 'UPSTREAM_TENANT_FILTER_UNAVAILABLE', null]);
  const ticketAt20 = one('atera', state('ticket', 'OK', null, 20));
  assert.equal(ticketAt20.status, 'OK', 'tickets have a 30-minute window');
  const unconfigured = mapResources([connection('huntress', [])], now)[0]!;
  assert.deepEqual([unconfigured.status, unconfigured.safeErrorCode, unconfigured.items], ['MISSING', 'SYNC_NOT_CONFIGURED', null]);
});

test('completeness is COMPLETE only when every expected resource is OK', () => {
  const graph = (connections: DbConnectionRow[]) => ({ id: 'demo-gasta', name: 'Gasta (synthetic)', entities: [], connections });
  const stats = { total: 0, bySeverity: [] };
  assert.equal(mapClientContext(scope, graph([connection('huntress', [state('incident', 'OK', null, 1)])]), [], stats, null, now).completeness, 'COMPLETE');
  assert.equal(mapClientContext(scope, graph([connection('huntress', [state('incident', 'OK', null, 20)])]), [], stats, null, now).completeness, 'PARTIAL');
  assert.equal(mapClientContext(scope, graph([connection('huntress', [state('incident', 'OK', null, 1)]),
    connection('atera', [state('ticket', 'OK', null, 1), state('alert', 'UNAVAILABLE', 'UPSTREAM_TENANT_FILTER_UNAVAILABLE', null)])]), [], stats, null, now).completeness,
    'PARTIAL', 'an unavailable resource keeps the context partial');
});
